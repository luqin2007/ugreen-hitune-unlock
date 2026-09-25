#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Round-trip check: the JS string baked into the dex must equal the source file.

Guards against generator/javac/d8 mangling (e.g. lost newlines silently turning
the whole payload into one line, where any `//` comment comments out the rest).

Usage: verify_embedded_payload.py <classes.dex> <unlock_payload.js>
"""
import io
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                '..', '..', 'tools'))

from dexparse import Dex  # noqa: E402  (lives in the repo's tools/ dir)


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    dex_path, js_path = sys.argv[1], sys.argv[2]

    dex = Dex(dex_path)
    marker = 'UG_HITUNE_UNLOCK_V1'
    embedded = None
    for i in range(dex.string_ids_size):
        s = dex.string(i)
        if marker in s:
            embedded = s
            break

    if embedded is None:
        sys.exit('FAIL: payload string not found in ' + dex_path)

    with io.open(js_path, encoding='utf-8') as fh:
        source = fh.read().replace('\r\n', '\n').replace('\r', '\n')

    if embedded != source:
        print('FAIL: embedded payload differs from ' + js_path)
        print('      dex %d chars / source %d chars' % (len(embedded), len(source)))
        print('      newlines in dex: %d, in source: %d'
              % (embedded.count('\n'), source.count('\n')))
        for i, (a, b) in enumerate(zip(source, embedded)):
            if a != b:
                print('      first difference at char %d: source=%r dex=%r'
                      % (i, source[max(0, i - 30):i + 30],
                         embedded[max(0, i - 30):i + 30]))
                break
        sys.exit(1)

    print('    payload round-trip OK (%d chars, %d newlines)'
          % (len(embedded), embedded.count('\n')))


if __name__ == '__main__':
    main()
