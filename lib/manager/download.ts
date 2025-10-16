"use strict";
// License: MIT

// eslint-disable-next-line no-unused-vars
import { CHROME, downloads, DownloadOptions, runtime } from "../browser";
import { Prefs, PrefWatcher } from "../prefs";
import { PromiseSerializer } from "../pserializer";
import { filterInSitu, parsePath } from "../util";
import { BaseDownload } from "./basedownload";
// eslint-disable-next-line no-unused-vars
import { Manager } from "./man";
import Renamer from "./renamer";
import {
  CANCELABLE,
  CANCELED,
  DONE,
  FORCABLE,
  MISSING,
  PAUSEABLE,
  PAUSED,
  QUEUED,
  RUNNING,
  RETRYING
} from "./state";
// eslint-disable-next-line no-unused-vars
import { Preroller, PrerollResults } from "./preroller";

function isRecoverable(error: string) {
  switch (error) {
  case "SERVER_FAILED":
    return true;

  default:
    return error.startsWith("NETWORK_");
  }
}

const RETRIES = new PrefWatcher("retries", 5);
const RETRY_TIME = new PrefWatcher("retry-time", 5);

export class Download extends BaseDownload {
  public manager: Manager;

  public manId: number;

  // If this download is handled by the native host, we store the
  // long-lived port and the native download id here so we can
  // send pause/resume/cancel control messages.
  public nativePort: any | null = null;
  public nativeDid: string | null = null;

  public removed: boolean;

  public position: number;

  public dbId: number;

  public deadline: number;

  public conflictAction: string;

  constructor(manager: Manager, options: any) {
    super(options);
    this.manager = manager;
    this.start = PromiseSerializer.wrapNew(1, this, this.start);
    this.removed = false;
    this.position = -1;
  }

  markDirty() {
    this.renamer = new Renamer(this);
    this.manager.setDirty(this);
  }

  changeState(newState: number) {
    const oldState = this.state;
    if (oldState === newState) {
      return;
    }
    this.state = newState;
    this.error = "";
    this.manager.changedState(this, oldState, this.state);
    this.markDirty();
  }

  async start() {
    if (this.state !== QUEUED) {
      throw new Error("invalid state");
    }
    if (this.manId) {
      const {manId: id} = this;
      try {
        const state = (await downloads.search({id})).pop() || {};
        if (state.state === "in_progress" && !state.error && !state.paused) {
          this.changeState(RUNNING);
          this.updateStateFromBrowser();
          return;
        }
        if (state.state === "complete") {
          this.changeState(DONE);
          this.updateStateFromBrowser();
          return;
        }
        if (!state.canResume) {
          throw new Error("Cannot resume");
        }
        // Cannot await here
        // Firefox bug: will not return until download is finished
        downloads.resume(id).catch(console.error);
        this.changeState(RUNNING);
        return;
      }
      catch (ex) {
        console.error("cannot resume", ex);
        this.manager.removeManId(this.manId);
        this.removeFromBrowser();
      }
    }
    if (this.state !== QUEUED) {
      throw new Error("invalid state");
    }
    console.log("starting", this.toString(), this.toMsg());
    this.changeState(RUNNING);

    // Do NOT await
    this.reallyStart();
  }

  private async reallyStart() {
    try {
      if (!this.prerolled) {
        await this.maybePreroll();
        if (this.state !== RUNNING) {
          // Aborted by preroll
          return;
        }
      }
      this.conflictAction = await Prefs.get("conflict-action");
      const options: DownloadOptions = {
        conflictAction: this.conflictAction,
        saveAs: false,
        url: this.url,
        headers: [],
      };
      if (!CHROME) {
        options.filename = this.dest.full;
      }
      if (!CHROME && this.private) {
        options.incognito = true;
      }
      if (this.postData) {
        options.body = this.postData;
        options.method = "POST";
      }
      if (!CHROME && this.referrer) {
        options.headers.push({
          name: "Referer",
          value: this.referrer
        });
      }
      else if (CHROME) {
        options.headers.push({
          name: "X-DTA-ID",
          value: this.sessionId.toString(),
        });
      }
      if (this.manId) {
        this.manager.removeManId(this.manId);
      }

      try {
        this.manager.addManId(
          this.manId = await downloads.download(options), this);
      }
      catch (ex) {
        if (!this.referrer) {
          throw ex;
        }
        // Re-attempt without referrer
        filterInSitu(options.headers, h => h.name !== "Referer");
        try {
          this.manager.addManId(
            this.manId = await downloads.download(options), this);
        }
        catch (ex2) {
          // If we're on Chrome and native messaging is available, try native host
          if (CHROME && (runtime as any) && (runtime as any).sendNativeMessage) {
            try {
                // Use a long-lived native port to receive progress events
                const port = (runtime as any).connectNative("downthemall.native");
                const msg: any = {
                  type: "download_start",
                  url: this.url,
                  referrer: this.referrer,
                  headers: options.headers,
                  method: options.method,
                  body: options.body,
                  filename: this.dest ? this.dest.full : undefined
                };
                // remember native port so we can control the download
                this.nativePort = port;
                port.postMessage(msg);

                const onMessage = (m: any) => {
                  if (!m) {
                    return;
                  }

                  // initial ok with id
                  if (m.ok && m.id) {
                    this.nativeDid = m.id;
                  }

                  // progress updates
                  if (m.type === 'progress') {
                    this.written = m.downloaded || this.written;
                    this.totalSize = m.total || this.totalSize;
                    this.browserName = m.path || this.browserName;
                    this.markDirty();
                    return;
                  }

                  // paused/cancelled events from native host
                  if (m.type === 'paused') {
                    this.written = m.downloaded || this.written;
                    this.changeState(PAUSED);
                    this.markDirty();
                    return;
                  }
                  if (m.type === 'cancelled') {
                      this.error = 'cancelled';
                      this.reset();
                      this.changeState(CANCELED);
                      this.markDirty();
                      try { this.cleanupNative(); } catch (e) { }
                    return;
                  }

                  // download finished; ask native host to move temp file to final path
                  if (m.type === 'done') {
                    const nativePath = m.path;
                    // Determine final destination: use configured pref if available, else use this.dest.full if it's an absolute path
                    (async () => {
                      try {
                        const cfg = await Prefs.get('native-download-folder', '') as string;
                        let finalPath = nativePath;
                        const filename = (this.dest && this.dest.full) ? this.dest.full.split(/[/\\]+/).pop() : nativePath.split('/').pop();
                        if (cfg && cfg.length) {
                          // ensure trailing slash handling
                          const sep = cfg.endsWith('/') ? '' : '/';
                          finalPath = `${cfg}${sep}${filename}`;
                        }
                        else if (this.dest && this.dest.full && this.dest.full.includes('/')) {
                          finalPath = this.dest.full;
                        }
                        const moveReq = { type: 'move', src: nativePath, dst: finalPath };
                        try {
                          port.postMessage(moveReq);
                        }
                        catch (e) {
                          console.warn('failed to post move request', e);
                          // fallback: mark done with native path
                          this.browserName = nativePath;
                          this.written = this.totalSize = m.size || this.written || this.totalSize;
                          this.changeState(DONE);
                          this.markDirty();
                          try { this.cleanupNative(); } catch (err) { }
                        }
                      }
                      catch (ex) {
                        console.warn('failed to determine final path', ex && ex.message || ex);
                        this.browserName = nativePath;
                        this.written = this.totalSize = m.size || this.written || this.totalSize;
                        this.changeState(DONE);
                        this.markDirty();
                        try { this.cleanupNative(); } catch (err) { }
                      }
                    })();
                    return;
                  }

                  // move or other ok responses
                  if (m.ok && m.path) {
                    const movedPath = m.path;
                    (async () => {
                      try {
                        const fileUrl = `file://${movedPath}`;
                        const downloadOpts: DownloadOptions = {
                          url: fileUrl,
                          saveAs: false,
                          conflictAction: this.conflictAction || 'uniquify',
                          headers: [],
                          filename: (this.dest && this.dest.full) || undefined
                        };
                        const id = await downloads.download(downloadOpts) as number;
                        const manId = typeof id === 'number' ? id : 0;
                        if (manId) {
                          this.manager.addManId(manId, this);
                          this.manId = manId;
                          this.browserName = (this.dest && this.dest.full) || movedPath;
                          this.written = this.totalSize = m.size || this.written || this.totalSize;
                          this.changeState(DONE);
                          this.markDirty();
                          try { this.cleanupNative(); } catch (e) { }
                          try { this.cleanupNative(); } catch (err) { }
                          return;
                        }
                      }
                      catch (err) {
                        console.warn('Registering moved file in downloads failed', err && err.message || err);
                      }
                      // fallback
                      this.browserName = movedPath;
                      this.written = this.totalSize = m.size || this.written || this.totalSize;
                      this.changeState(DONE);
                      this.markDirty();
                      try { this.cleanupNative(); } catch (e) { }
                      try { this.cleanupNative(); } catch (e) { }
                    })();
                    return;
                  }

                  if (m.type === 'error') {
                    console.error('native download error', m.error);
                    try { this.cleanupNative(); } catch (e) { }
                    return;
                  }
                };
                try {
                  port.onMessage.addListener(onMessage);
                }
                catch (e) {
                  console.warn('native port message listener failed', e);
                }
                return;
              }
            catch (nex) {
              console.error("native download failed", nex);
              throw ex2;
            }
          }
          throw ex2;
        }
      }
      this.markDirty();
    }
    catch (ex) {
      console.error("failed to start download", ex.toString(), ex);
      try { this.cleanupNative(); } catch (e) { }
      this.changeState(CANCELED);
      this.error = ex.toString();
    }
  }

  private async maybePreroll() {
    try {
      if (this.prerolled) {
        // Check again, just in case, async and all
        return;
      }
      const roller = new Preroller(this);
      if (!roller.shouldPreroll) {
        return;
      }
      const res = await roller.roll();
      if (!res) {
        return;
      }
      this.adoptPrerollResults(res);
    }
    catch (ex) {
      console.error("Failed to preroll", this, ex.toString(), ex.stack, ex);
    }
    finally {
      if (this.state === RUNNING) {
        this.prerolled = true;
        this.markDirty();
      }
    }
  }

  adoptPrerollResults(res: PrerollResults) {
    if (res.mime) {
      this.mime = res.mime;
    }
    if (res.name) {
      this.serverName = res.name;
    }
    if (res.error) {
      this.cancelAccordingToError(res.error);
    }
  }

  resume(forced = false) {
    if (!(FORCABLE & this.state)) {
      return;
    }
    if (this.state !== QUEUED) {
      this.changeState(QUEUED);
    }
    if (forced) {
      this.manager.startDownload(this);
    }
    // If this was a native-managed download and was paused, request native resume
    if (this.nativePort && this.nativeDid) {
      try {
        this.nativePort.postMessage({type: 'download_resume', id: this.nativeDid});
      }
      catch (ex) {
        console.error('native resume failed', ex);
      }
    }
  }

  async pause(retry?: boolean) {
    if (!(PAUSEABLE & this.state)) {
      return;
    }

    if (!retry) {
      this.retries = 0;
      this.deadline = 0;
    }
    else {
      // eslint-disable-next-line no-magic-numbers
      this.deadline = Date.now() + RETRY_TIME.value * 60 * 1000;
    }

    if (this.state === RUNNING && this.manId) {
      try {
        await downloads.pause(this.manId);
      }
      catch (ex) {
        console.error("pause", ex.toString(), ex);
        this.cancel();
        return;
      }
    }

    this.changeState(retry ? RETRYING : PAUSED);
  }

  reset() {
    this.prerolled = false;
    this.manId = 0;
    this.written = this.totalSize = 0;
    this.mime = this.serverName = this.browserName = "";
    this.retries = 0;
    this.deadline = 0;
    // ensure native resources are cleaned up
    try {
      this.cleanupNative();
    }
    catch (e) {
      // ignore
    }
  }

  // Disconnect and clear any native port/id associated with this download
  private cleanupNative() {
    try {
      if (this.nativePort && typeof this.nativePort.disconnect === 'function') {
        try { this.nativePort.disconnect(); } catch (e) { }
      }
    }
    finally {
      this.nativePort = null;
      this.nativeDid = null;
    }
  }

  async removeFromBrowser() {
    const {manId: id} = this;
    try {
      await downloads.cancel(id);
    }
    catch (ex) {
      // ignored
    }
    await new Promise(r => setTimeout(r, 1000));
    try {
      await downloads.erase({id});
    }
    catch (ex) {
      console.error(id, ex.toString(), ex);
      // ignored
    }
  }

  cancel() {
    if (!(CANCELABLE & this.state)) {
      return;
    }
    // If native-managed, inform native host to cancel
    if (this.nativePort && this.nativeDid) {
      try {
        this.nativePort.postMessage({type: 'download_cancel', id: this.nativeDid});
      }
      catch (ex) {
        console.error('native cancel failed', ex);
      }
    }
    if (this.manId) {
      this.manager.removeManId(this.manId);
      this.removeFromBrowser();
    }
    this.reset();
    this.changeState(CANCELED);
  }

  async cancelAccordingToError(error: string) {
    if (!isRecoverable(error) || ++this.retries > RETRIES.value) {
      this.cancel();
      this.error = error;
      return;
    }

    await this.pause(true);
    this.error = error;
  }

  setMissing() {
    if (this.manId) {
      this.manager.removeManId(this.manId);
      this.removeFromBrowser();
    }
    this.reset();
    this.changeState(MISSING);
  }

  async maybeMissing() {
    if (!this.manId) {
      return null;
    }
    const {manId: id} = this;
    try {
      const dls = await downloads.search({id});
      if (!dls.length) {
        this.setMissing();
        return this;
      }
    }
    catch (ex) {
      console.error("oops", id, ex.toString(), ex);
      this.setMissing();
      return this;
    }
    return null;
  }

  adoptSize(state: any) {
    const {
      bytesReceived,
      totalBytes,
      fileSize
    } = state;
    this.written = Math.max(0, bytesReceived);
    this.totalSize = Math.max(0, fileSize >= 0 ? fileSize : totalBytes);
  }

  async updateStateFromBrowser() {
    try {
      const state = (await downloads.search({id: this.manId})).pop();
      const {filename, error} = state;
      const path = parsePath(filename);
      this.browserName = path.name;
      this.adoptSize(state);
      if (!this.mime && state.mime) {
        this.mime = state.mime;
      }
      this.markDirty();
      switch (state.state) {
      case "in_progress":
        if (state.paused) {
          this.changeState(PAUSED);
        }
        else if (error) {
          this.cancelAccordingToError(error);
        }
        else {
          this.changeState(RUNNING);
        }
        break;

      case "interrupted":
        if (state.paused) {
          this.changeState(PAUSED);
        }
        else if (error) {
          this.cancelAccordingToError(error);
        }
        else {
          this.cancel();
          this.error = error || "";
        }
        break;

      case "complete":
        this.changeState(DONE);
        break;
      }
    }
    catch (ex) {
      console.error("failed to handle state", ex.toString(), ex.stack, ex);
      this.setMissing();
    }
  }

  updateFromSuggestion(state: any) {
    const res: PrerollResults = {};
    if (state.mime) {
      res.mime = state.mime;
    }
    if (state.filename) {
      res.name = state.filename;
    }
    if (state.finalUrl) {
      res.finalURL = state.finalUrl;
      const detected = Preroller.maybeFindNameFromSearchParams(this, res);
      if (detected) {
        res.name = detected;
      }
    }
    try {
      this.adoptPrerollResults(res);
    }
    finally {
      this.markDirty();
    }
  }
}
