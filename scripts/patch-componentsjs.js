// scripts/patch-componentsjs.js
//
// Menambal componentsjs (dipakai Community Solid Server) agar CSS dapat berjalan
// dari folder project yang mengandung spasi, mis. C:\Users\Nama Lengkap\Desktop\P2Pod.
//
// Masalah: RdfParser membangun base IRI `file://` + path MENTAH tanpa URL-encoding.
// Jika path mengandung spasi, IRI hasilnya tidak valid dan parsing JSON-LD gagal:
//   "Invalid term IRI: file://C:/Users/Nama Lengkap/.../WebAclMetadataCollector"
//
// Patch: encodeURI() pada base IRI file:// tersebut (perubahan perilaku no-op
// untuk path yang tidak memerlukan encoding).
//
// Sifat script ini:
// - Idempotent  : aman dijalankan berulang kali.
// - Defensif    : bila pola tidak ditemukan (versi componentsjs berubah), hanya
//                 memberi peringatan, tidak menggagalkan `npm install`.
//
// Dipanggil otomatis lewat `postinstall`, atau manual: npm run patch:css

'use strict';

const fs = require('fs');
const path = require('path');

const TARGET = path.join(__dirname, '..', 'node_modules', 'componentsjs', 'lib', 'rdf', 'RdfParser.js');
const MARKER = 'encodeURI(options.baseIRI)';
const ORIGINAL = 'options.baseIRI = `file://${options.baseIRI}`;';
const PATCHED = 'options.baseIRI = `file://${encodeURI(options.baseIRI)}`;';

if (!fs.existsSync(TARGET)) {
  console.error('[patch:css] componentsjs tidak ditemukan. Jalankan `npm install` terlebih dahulu.');
  process.exit(1);
}

let source = fs.readFileSync(TARGET, 'utf8');

if (source.includes(MARKER)) {
  console.log('[patch:css] componentsjs sudah ter-patch (folder dengan spasi didukung).');
  process.exit(0);
}

if (!source.includes(ORIGINAL)) {
  console.warn('[patch:css] PERINGATAN: pola patch tidak ditemukan — versi componentsjs mungkin berubah.');
  console.warn('[patch:css] Jika CSS gagal start dari folder ber-spasi, cek: node_modules/componentsjs/lib/rdf/RdfParser.js');
  process.exit(0);
}

// Gunakan function-replacement agar karakter '$' pada string patch tidak diinterpretasikan.
source = source.replace(ORIGINAL, () => PATCHED);
fs.writeFileSync(TARGET, source);
console.log('[patch:css] componentsjs berhasil di-patch (dukungan folder dengan spasi).');
