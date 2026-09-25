#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Turn js/unlock_payload.js into src/com/ugreen/unlock/JsPayload.java.

Keeps the JS readable/editable and avoids hand-escaping into a Java literal.
"""
import io
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
JS_PATH = os.path.join(ROOT, 'js', 'unlock_payload.js')
OUT_PATH = os.path.join(ROOT, 'src', 'com', 'ugreen', 'unlock', 'JsPayload.java')

HEADER = '''package com.ugreen.unlock;

/**
 * GENERATED FILE - do not edit by hand.
 * Source: module/js/unlock_payload.js  (regenerate with tools/gen_payload.py)
 */
public final class JsPayload {

    private JsPayload() {
    }

    public static final String JS = %s;
}
'''


def main():
    with io.open(JS_PATH, encoding='utf-8') as fh:
        js = fh.read()

    # normalise line endings so the emitted \n is stable
    js = js.replace('\r\n', '\n').replace('\r', '\n')

    # One Java string literal per source line keeps the diff readable.
    # Newlines MUST be preserved: the payload contains `//` comments, and a
    # collapsed one-liner would comment out everything after the first one.
    # ensure_ascii=False keeps CJK in the source; javac runs with -encoding UTF-8.
    lines = js.split('\n')
    last = len(lines) - 1
    literals = [
        json.dumps(line if i == last else line + '\n', ensure_ascii=False)
        for i, line in enumerate(lines)
    ]
    joined = '\n            + '.join(literals)

    with io.open(OUT_PATH, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(HEADER % joined)

    print('wrote %s (%d bytes of JS, %d lines)' % (OUT_PATH, len(js.encode('utf-8')), len(literals)))


if __name__ == '__main__':
    main()
