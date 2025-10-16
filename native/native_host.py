#!/usr/bin/env python3
"""
Simple native messaging host for DownThemAll! (preroll and simple header fetch)

Protocol: Chrome/Firefox native messaging (4-byte little-endian length prefix)
Messages are JSON objects. Supported request shape:
  { "type": "preroll", "url": "...", "referrer": "...", "range": "bytes=0-1" }

Response:
  { "ok": true, "headers": [[name, value], ...], "finalUrl": "...", "status": 200 }
Or on error:
  { "ok": false, "error": "message" }

This script uses only stdlib so it has no external dependencies.
You must register the native manifest for your platform and set the correct path.
See the accompanying JSON template files.
"""
import sys
import struct
import json
import urllib.request
import urllib.error
import threading
import uuid


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    length = struct.unpack('<I', raw_length)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode('utf-8'))


def send_message(message):
    encoded = json.dumps(message).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def perform_preroll(req):
    url = req.get('url')
    referrer = req.get('referrer')
    range_header = req.get('range', 'bytes=0-1')
    headers = {}
    try:
        req_obj = urllib.request.Request(url, method='GET')
        req_obj.add_header('Range', range_header)
        if referrer:
            req_obj.add_header('Referer', referrer)
        # Add optional headers
        for h in req.get('headers', []):
            if isinstance(h, dict) and 'name' in h and 'value' in h:
                req_obj.add_header(h['name'], h['value'])

        with urllib.request.urlopen(req_obj, timeout=10) as res:
            hdrs = list(res.getheaders())
            final_url = res.geturl()
            status = res.getcode()
            return {'ok': True, 'headers': hdrs, 'finalUrl': final_url, 'status': status}
    except Exception as ex:
        return {'ok': False, 'error': str(ex)}


def perform_download(req):
    # This function is retained for one-shot downloads, but for interactive
    # downloads we use threaded_download which sends progress messages.
    return {'ok': False, 'error': 'use interactive download via connectNative'}


DOWNLOADS = {}


def threaded_download(did, req):
    url = req.get('url')
    referrer = req.get('referrer')
    headers = req.get('headers', [])
    method = req.get('method', 'GET')
    body = req.get('body')
    filename = req.get('filename')
    import tempfile, os, time
    info = DOWNLOADS[did]
    chunk_size = 8192
    try:
        downloaded = info.get('downloaded', 0)
        mode = 'ab' if downloaded else 'wb'
        # Support resuming with Range header
        while True:
            req_obj = urllib.request.Request(url, data=(body.encode('utf-8') if body else None), method=method)
            if referrer:
                req_obj.add_header('Referer', referrer)
            for h in headers:
                if isinstance(h, dict) and 'name' in h and 'value' in h:
                    req_obj.add_header(h['name'], h['value'])
            if downloaded:
                req_obj.add_header('Range', f'bytes={downloaded}-')

            with urllib.request.urlopen(req_obj, timeout=30) as res:
                status = res.getcode()
                final_url = res.geturl()
                cl = res.getheader('Content-Length')
                total = None
                try:
                    if cl is not None:
                        total = int(cl) + downloaded if downloaded and res.getheader('Content-Range') else int(cl)
                except Exception:
                    total = None

                # open file
                tf_path = info.get('path')
                if not tf_path:
                    suffix = ''
                    try:
                        suffix = os.path.splitext(filename)[1]
                    except Exception:
                        suffix = ''
                    tf = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
                    tf_path = tf.name
                    tf.close()
                    info['path'] = tf_path

                with open(tf_path, mode) as tf:
                    while True:
                        if info.get('cancel'):
                            send_message({'type': 'cancelled', 'id': did})
                            return
                        if info.get('pause'):
                            send_message({'type': 'paused', 'id': did, 'downloaded': downloaded})
                            # wait until pause cleared or cancel
                            while info.get('pause') and not info.get('cancel'):
                                time.sleep(0.1)
                            if info.get('cancel'):
                                send_message({'type': 'cancelled', 'id': did})
                                return
                            # resume will restart loop, set mode to append
                            mode = 'ab'
                            break
                        chunk = res.read(chunk_size)
                        if not chunk:
                            break
                        tf.write(chunk)
                        downloaded += len(chunk)
                        info['downloaded'] = downloaded
                        # send progress update
                        send_message({'type': 'progress', 'id': did, 'downloaded': downloaded, 'path': tf_path, 'total': total})
                    # finished reading
                # finished one request; check if server returned complete
                send_message({'type': 'done', 'id': did, 'path': tf_path, 'size': downloaded, 'finalUrl': final_url, 'status': status})
                return
    except Exception as ex:
        send_message({'type': 'error', 'id': did, 'error': str(ex)})
        return


def perform_move(req):
    src = req.get('src')
    dst = req.get('dst')
    import os, shutil
    try:
        # Ensure dst directory exists
        dstdir = os.path.dirname(dst)
        if dstdir and not os.path.exists(dstdir):
            os.makedirs(dstdir, exist_ok=True)
        shutil.move(src, dst)
        return {'ok': True, 'path': dst}
    except Exception as ex:
        return {'ok': False, 'error': str(ex)}


def choose_folder(req):
    # Accept optional 'default' in req to open chooser at that folder
    default = req.get('default')
    # Try tkinter first (widely available on desktop Python)
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        if default:
            path = filedialog.askdirectory(initialdir=default)
        else:
            path = filedialog.askdirectory()
        try:
            root.destroy()
        except Exception:
            pass
        if path:
            return {'ok': True, 'path': path}
        return {'ok': False, 'error': 'no_selection'}
    except Exception as ex:
        # Try fallbacks commonly available on Linux desktops: zenity or kdialog
        try:
            import shutil, subprocess, os
            chooser = None
            if shutil.which('zenity'):
                chooser = ['zenity', '--file-selection', '--directory']
                if default:
                    chooser.extend(['--filename', default])
            elif shutil.which('kdialog'):
                chooser = ['kdialog', '--getexistingdirectory']
                if default:
                    chooser.append(default)
            if chooser:
                p = subprocess.run(chooser, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                if p.returncode == 0 and p.stdout:
                    path = p.stdout.strip()
                    return {'ok': True, 'path': path}
                return {'ok': False, 'error': 'no_selection', 'fallback': os.path.expanduser('~')}
        except Exception:
            pass
        # macOS fallback: use AppleScript via osascript
        try:
            import subprocess, os, sys
            if sys.platform == 'darwin':
                # Ask for a folder and return POSIX path
                cmd = ['osascript', '-e', 'POSIX path of (choose folder with prompt "Select folder")']
                p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                if p.returncode == 0 and p.stdout:
                    return {'ok': True, 'path': p.stdout.strip()}
                return {'ok': False, 'error': 'no_selection', 'fallback': os.path.expanduser('~')}
        except Exception:
            pass
        # Windows fallback: use PowerShell FolderBrowserDialog if available
        try:
            import subprocess, os, sys
            if sys.platform.startswith('win'):
                ps = (
                    "Add-Type -AssemblyName System.Windows.Forms;"
                    "$f = New-Object System.Windows.Forms.FolderBrowserDialog;"
                    "if($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){Write-Host $f.SelectedPath}"
                )
                p = subprocess.run(['powershell', '-NoProfile', '-Command', ps], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                if p.returncode == 0 and p.stdout:
                    return {'ok': True, 'path': p.stdout.strip()}
                return {'ok': False, 'error': 'no_selection', 'fallback': os.path.expanduser('~')}
        except Exception:
            pass
        # Final fallback: return home directory as suggestion and the error
        try:
            import os
            home = os.path.expanduser('~')
            return {'ok': False, 'error': str(ex), 'fallback': home}
        except Exception:
            return {'ok': False, 'error': str(ex)}


def stat_path(req):
    # Check whether path is absolute and writable (Linux-focused)
    path = req.get('path')
    # optional: minimum required bytes (integer)
    min_bytes = req.get('required_bytes')
    # optional: if true, attempt to create the directory when missing (after confirmation)
    auto_create = bool(req.get('auto_create'))
    import os, stat
    if not path:
        return {'ok': False, 'error': 'no_path'}
    try:
        abs_path = os.path.abspath(path)
        # If path exists and is dir
        if os.path.exists(abs_path):
            if not os.path.isdir(abs_path):
                return {'ok': False, 'error': 'not_directory'}
            # test writability by attempting to create a temp file
            try:
                testfile = os.path.join(abs_path, f'.dta_write_test_{uuid.uuid4().hex}')
                with open(testfile, 'w') as f:
                    f.write('x')
                os.remove(testfile)
                # if min_bytes requested, check free space
                if min_bytes is not None:
                    try:
                        st = os.statvfs(abs_path)
                        free = st.f_bavail * st.f_frsize
                        if free < int(min_bytes):
                            return {'ok': False, 'error': 'insufficient_space', 'free_bytes': free}
                    except Exception as ex:
                        return {'ok': False, 'error': 'statvfs_failed', 'msg': str(ex)}
                return {'ok': True, 'path': abs_path}
            except Exception as ex:
                return {'ok': False, 'error': 'not_writable', 'msg': str(ex)}
        else:
            # If it doesn't exist, check parent is writable so we can create it
            parent = os.path.dirname(abs_path) or '/'
            if os.path.exists(parent) and os.access(parent, os.W_OK):
                # if auto_create requested, attempt to create the directory
                if auto_create:
                    try:
                        os.makedirs(abs_path, exist_ok=True)
                        return {'ok': True, 'path': abs_path, 'created': True}
                    except Exception as ex:
                        return {'ok': False, 'error': 'create_failed', 'msg': str(ex)}
                return {'ok': True, 'path': abs_path}
            return {'ok': False, 'error': 'parent_not_writable'}
    except Exception as ex:
        return {'ok': False, 'error': str(ex)}


def main():
    while True:
        msg = read_message()
        if msg is None:
            break
        t = msg.get('type')
        if t == 'preroll':
            res = perform_preroll(msg)
            send_message(res)
        elif t == 'download':
            # legacy one-shot download (returns error — prefer interactive)
            res = perform_download(msg)
            send_message(res)
        elif t == 'download_start':
            # start an interactive download which will emit progress/done messages
            did = str(uuid.uuid4())
            DOWNLOADS[did] = {'id': did, 'url': msg.get('url'), 'pause': False, 'cancel': False}
            thread = threading.Thread(target=threaded_download, args=(did, msg), daemon=True)
            DOWNLOADS[did]['thread'] = thread
            thread.start()
            send_message({'ok': True, 'id': did})
        elif t == 'download_pause':
            did = msg.get('id')
            if did and did in DOWNLOADS:
                DOWNLOADS[did]['pause'] = True
                send_message({'ok': True, 'id': did})
            else:
                send_message({'ok': False, 'error': 'unknown id'})
        elif t == 'download_resume':
            did = msg.get('id')
            if did and did in DOWNLOADS:
                DOWNLOADS[did]['pause'] = False
                send_message({'ok': True, 'id': did})
            else:
                send_message({'ok': False, 'error': 'unknown id'})
        elif t == 'download_cancel':
            did = msg.get('id')
            if did and did in DOWNLOADS:
                DOWNLOADS[did]['cancel'] = True
                send_message({'ok': True, 'id': did})
            else:
                send_message({'ok': False, 'error': 'unknown id'})
        elif t == 'move':
            res = perform_move(msg)
            send_message(res)
        elif t == 'choose_folder':
            res = choose_folder(msg)
            send_message(res)
        elif t == 'stat_path':
            res = stat_path(msg)
            send_message(res)
        else:
            send_message({'ok': False, 'error': 'unknown type'})


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
