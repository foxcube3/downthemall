Native messaging helper for DownThemAll!

Files:
- `native_host.py` - the native host script (Python 3, no dependencies).
- `native-messaging-host.downthemall.json.template` - manifest template for registering the native host (Linux example).

Registering on Linux

1. Copy `native/native_host.py` to a permanent location, e.g. `/usr/local/bin/downthemall-native-host` and make it executable.
    ```bash
    sudo cp native/native_host.py /usr/local/bin/downthemall-native-host
    sudo chmod +x /usr/local/bin/downthemall-native-host
    ```

2. Create a manifest file at `~/.config/google-chrome/NativeMessagingHosts/downthemall.native.json` (or the appropriate Chromium/Chrome path) with the contents from `native-messaging-host.downthemall.json.template`, adjusting the `path` entry if you placed the script elsewhere.

3. Replace `<<EXTENSION_ID>>` in the template with your extension's ID. To get the extension ID during development when loading unpacked, check `chrome://extensions` (toggle Developer mode). For testing you can temporarily put the extension id there or add multiple allowed origins.

Example manifest content (replace path and extension id):

```json
{
   "name": "downthemall.native",
   "description": "DownThemAll native messaging host (preroll helper)",
   "path": "/usr/local/bin/downthemall-native-host",
   "type": "stdio",
   "allowed_origins": [
      "chrome-extension://your-extension-id/"
   ]
}
```

4. After placing the manifest, ensure Chrome/Chromium is restarted. The extension can now call `runtime.sendNativeMessage('downthemall.native', message)` to interact with the helper.

Notes
- On macOS/Windows the manifest location and format differs; consult the browser docs.
- Native messaging bypasses many extension limitations; do not expose it to untrusted origins.


Notes
- On macOS/Windows the manifest location and format differs; consult the browser docs.
- Native messaging is powerful and bypasses some extension restrictions; be careful with security and allowed origins.

Download API
---------------
The native host now supports a `download` request which streams the remote URL to a temporary file and returns the local path. Example request:

```json
{
   "type": "download",
   "url": "https://example.com/file.zip",
   "referrer": "https://origin.example/",
   "headers": [{"name":"X-Foo","value":"bar"}],
   "filename": "file.zip"
}
```

Response on success:
```json
{ "ok": true, "path": "/tmp/tmpabcd1234", "size": 123456, "finalUrl": "https://...", "status": 200 }
```

Notes on cleanup
- The native host writes a temporary file and returns its path. The extension will need to move or import the file into its download database and remove the temporary file when appropriate. Be careful with permissions and user expectations.

Security and UX notes
Interactive download protocol
----------------------------
Start a download:

```json
{ "type": "download_start", "url": "https://example.com/file.zip", "referrer": "https://...", "filename": "file.zip" }
```

The host responds with an id:

```json
{ "ok": true, "id": "<download-id>" }
```

Events sent by the native host (async messages):
- `progress`: { type: 'progress', id, downloaded, total?, path }
- `paused`: { type: 'paused', id, downloaded }
- `done`: { type: 'done', id, path, size, finalUrl, status }
- `cancelled`: { type: 'cancelled', id }
- `error`: { type: 'error', id, error }

Control messages:
- Pause: { type: 'download_pause', id }
- Resume: { type: 'download_resume', id }
- Cancel: { type: 'download_cancel', id }

The extension should listen for these incoming messages and use them to update UI/progress. When `done` arrives, the `path` points to a temporary file which the extension must import/move and then remove.

- Native downloads bypass the browser download UI and permissions model; consider prompting the user and ensuring temporary files are stored in an appropriate directory that your extension can access.

Installer helper
----------------
This repository includes a `manifest.template.json` and a small installer script `install_native_host.sh` that helps writing the manifest to common user-level locations for Chrome/Chromium and Firefox on Linux.

Usage example (from project/native):

```bash
./install_native_host.sh --user /home/you/bin/downthemall-native-host --ext-id <EXTENSION_ID>
```

The script will substitute the host absolute path and extension id into a generated manifest and copy it to a likely target directory such as `~/.config/google-chrome/NativeMessagingHosts/` or `~/.mozilla/native-messaging-hosts/`.

If you prefer, manually edit `manifest.template.json`, set `path` to the absolute path of the native host, replace `__EXTENSION_ID__` with your extension id, and copy the resulting JSON to the browser's native messaging hosts directory.

