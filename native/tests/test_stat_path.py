#!/usr/bin/env python3
import unittest
import tempfile
import os
import stat
import json
import subprocess

HOST = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'native_host.py'))
PYTHON = 'python3'

def send(msg):
    p = subprocess.Popen([PYTHON, HOST], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    data = json.dumps(msg)
    # write length prefix
    l = len(data.encode('utf-8'))
    p.stdin.write((l).to_bytes(4, 'little'))
    p.stdin.write(data)
    p.stdin.flush()
    # read response length
    raw = p.stdout.buffer.read(4)
    if not raw:
        raise RuntimeError('no response')
    length = int.from_bytes(raw, 'little')
    body = p.stdout.buffer.read(length).decode('utf-8')
    p.stdin.close()
    p.terminate()
    return json.loads(body)

class StatPathTests(unittest.TestCase):
    def test_existing_writable(self):
        with tempfile.TemporaryDirectory() as td:
            res = send({'type':'stat_path','path':td})
            self.assertTrue(res.get('ok'))
            self.assertEqual(res.get('path'), os.path.abspath(td))

    def test_auto_create(self):
        with tempfile.TemporaryDirectory() as td:
            newdir = os.path.join(td, 'subdir', 'inner')
            res = send({'type':'stat_path','path':newdir, 'auto_create': True})
            self.assertTrue(res.get('ok'))
            self.assertTrue(os.path.exists(res.get('path')))

    def test_insufficient_space(self):
        # We cannot easily force low disk space; instead pass enormous required_bytes to trigger insufficiency
        with tempfile.TemporaryDirectory() as td:
            res = send({'type':'stat_path','path':td, 'required_bytes': 1<<60})
            self.assertFalse(res.get('ok'))
            self.assertEqual(res.get('error'), 'insufficient_space')

if __name__ == '__main__':
    unittest.main()
