#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Unpack the parts of the UGREEN app APK that this project analyses.

`base.apk` is a ~195 MB proprietary installer and is deliberately NOT kept in
version control (see .gitignore). Run this first to rebuild the `work/extract`
tree that `module/tools/extract_fixtures.py` reads.

    python tools/extract_apk.py           # minimal: the H5 device page only (~5 MB)
    python tools/extract_apk.py --all     # everything incl. dex / resources.arsc (~112 MB)
    python tools/extract_apk.py --list    # show what the minimal mode would pick

Only the H5 device page is needed for the gesture-option work: that is where the
per-model capability table and the option lists live. The dex files are only
useful for the one-off "is the gesture UI native or JS?" question, which is
already answered in README section 1 -- hence --all is opt-in.
"""
import argparse
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
APK = os.path.join(ROOT, 'base.apk')
OUT = os.path.join(ROOT, 'work', 'extract')

# Exact paths the analysis reads.
WANTED = (
    'assets/static/device/index.html',
)
# Directories worth taking wholesale, restricted to text-ish files.
WANTED_DIRS = (
    'assets/static/device/assets/',
)
WANTED_EXT = ('.js', '.css', '.json', '.html')

# Obvious noise inside the wanted dirs (vendored PDF viewer, wallpapers, fonts).
SKIP_MARKERS = ('/pdf22228/', '/pdfjs-4.10.38-dist/', )


def selected(name, full):
    if full:
        return True
    if name in WANTED:
        return True
    for d in WANTED_DIRS:
        if name.startswith(d) and name.lower().endswith(WANTED_EXT):
            return not any(m in name for m in SKIP_MARKERS)
    return False


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--all', action='store_true',
                    help='extract the whole APK, not just the H5 device page')
    ap.add_argument('--list', action='store_true',
                    help='list the files minimal mode would extract, then exit')
    ap.add_argument('--apk', default=APK, help='path to the app APK')
    ap.add_argument('--out', default=OUT, help='output directory')
    args = ap.parse_args()

    if not os.path.isfile(args.apk):
        sys.exit('APK not found: %s\n'
                 'Place the UGREEN app installer there, or pass --apk <path>.' % args.apk)

    with zipfile.ZipFile(args.apk) as z:
        hits = [i for i in z.infolist()
                if not i.is_dir() and selected(i.filename, args.all)]

        if args.list:
            total = sum(i.file_size for i in hits)
            for i in hits:
                print('%10d  %s' % (i.file_size, i.filename))
            print('--- %d files, %.1f MB' % (len(hits), total / 1048576.0))
            return

        if not hits:
            sys.exit('nothing matched -- is the APK the UGREEN one?')

        total = 0
        for i in hits:
            dest = os.path.join(args.out, i.filename.replace('/', os.sep))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with z.open(i) as src, open(dest, 'wb') as dst:
                dst.write(src.read())
            total += i.file_size

        # Make the extracted bundle discoverable without hardcoding a build hash.
        assets = os.path.join(args.out, 'assets', 'static', 'device', 'assets')
        if os.path.isdir(assets):
            bundles = sorted(f for f in os.listdir(assets)
                             if f.startswith('index-') and f.endswith('.js')
                             and 'legacy' not in f)
            if bundles:
                print('    device bundle: assets/static/device/assets/%s' % bundles[0])

    print('extracted %d files (%.1f MB) -> %s' % (len(hits), total / 1048576.0, args.out))
    print('next: python module/tools/extract_fixtures.py')


if __name__ == '__main__':
    main()
