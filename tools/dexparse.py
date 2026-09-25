"""Minimal DEX parser: dump class -> superclass, interfaces, methods."""
import struct, sys, os, json

def uleb128(b, off):
    result = 0
    shift = 0
    while True:
        byte = b[off]
        off += 1
        result |= (byte & 0x7f) << shift
        if (byte & 0x80) == 0:
            break
        shift += 7
    return result, off

class Dex:
    def __init__(self, path):
        self.b = open(path, 'rb').read()
        b = self.b
        (self.string_ids_size, self.string_ids_off,
         self.type_ids_size, self.type_ids_off,
         self.proto_ids_size, self.proto_ids_off,
         self.field_ids_size, self.field_ids_off,
         self.method_ids_size, self.method_ids_off,
         self.class_defs_size, self.class_defs_off) = struct.unpack_from('<12I', b, 0x38)
        self.path = path

    def string(self, idx):
        off = struct.unpack_from('<I', self.b, self.string_ids_off + idx * 4)[0]
        # uleb128 utf16 length
        _, p = uleb128(self.b, off)
        end = self.b.index(b'\x00', p)
        return self.b[p:end].decode('utf-8', 'replace')

    def type(self, idx):
        if idx == 0xffffffff:
            return None
        return self.string(struct.unpack_from('<I', self.b, self.type_ids_off + idx * 4)[0])

    def method_name(self, idx):
        return self.string(struct.unpack_from('<I', self.b, self.method_ids_off + idx * 8 + 4)[0])

    def method_class(self, idx):
        return self.type(struct.unpack_from('<H', self.b, self.method_ids_off + idx * 8)[0])

    def methods(self):
        out = []
        for i in range(self.method_ids_size):
            out.append((self.method_class(i), self.method_name(i)))
        return out

    def class_defs(self):
        res = []
        for i in range(self.class_defs_size):
            off = self.class_defs_off + i * 32
            class_idx, access, super_idx, ifaces_off, src_idx, ann_off, cd_off, sv_off = \
                struct.unpack_from('<8I', self.b, off)
            res.append({
                'name': self.type(class_idx),
                'access': access,
                'super': self.type(super_idx),
                'interfaces_off': ifaces_off,
                'class_data_off': cd_off,
            })
        return res

    def class_data_methods(self, off):
        """Return list of method names defined in this class."""
        if off == 0:
            return []
        p = off
        static_fields_size, p = uleb128(self.b, p)
        instance_fields_size, p = uleb128(self.b, p)
        direct_methods_size, p = uleb128(self.b, p)
        virtual_methods_size, p = uleb128(self.b, p)
        for _ in range(static_fields_size + instance_fields_size):
            _, p = uleb128(self.b, p)
            _, p = uleb128(self.b, p)
        # NOTE: direct_methods and virtual_methods are two INDEPENDENT lists;
        # the first element of each is an absolute method index, the rest are diffs.
        names = []
        for count in (direct_methods_size, virtual_methods_size):
            midx = 0
            for _ in range(count):
                diff, p = uleb128(self.b, p)   # method_idx_diff (absolute for 1st)
                _, p = uleb128(self.b, p)      # access_flags
                _, p = uleb128(self.b, p)      # code_off
                midx += diff
                names.append(self.method_name(midx))
        return names


def load_all(paths):
    return [Dex(p) for p in paths]


if __name__ == '__main__':
    base = sys.argv[1] if len(sys.argv) > 1 else '.'
    files = [os.path.join(base, f) for f in ['classes.dex', 'classes2.dex', 'classes3.dex', 'classes4.dex']]
    files = [f for f in files if os.path.exists(f)]
    dexes = load_all(files)
    mode = sys.argv[2] if len(sys.argv) > 2 else 'webviewclient'

    if mode == 'webviewclient':
        want = sys.argv[3] if len(sys.argv) > 3 else 'Landroid/webkit/WebViewClient;'
        for d in dexes:
            for cd in d.class_defs():
                if cd['super'] == want:
                    ms = d.class_data_methods(cd['class_data_off'])
                    interesting = [m for m in ms if 'Intercept' in m or 'Page' in m or 'Url' in m or 'Url' in m]
                    print(f"[{os.path.basename(d.path)}] {cd['name']}")
                    print(f"     methods: {sorted(set(ms))}")
                    print()
    elif mode == 'findmethod':
        target = sys.argv[3]
        for d in dexes:
            for cd in d.class_defs():
                ms = d.class_data_methods(cd['class_data_off'])
                if target in ms:
                    print(f"[{os.path.basename(d.path)}] {cd['name']}  super={cd['super']}")
    elif mode == 'findstr':
        target = sys.argv[3]
        for d in dexes:
            for cd in d.class_defs():
                pass
        for d in dexes:
            for i in range(d.string_ids_size):
                s = d.string(i)
                if target in s:
                    print(f"[{os.path.basename(d.path)}] {s[:200]}")
