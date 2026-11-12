// SVG -> PNG for the picture cards, with resvg compiled to WebAssembly.
//
// An Edge Function is deployed as text files only, so the renderer (2.5 MB of wasm) and the two
// font files are downloaded from the npm CDN the first time a card is drawn in a worker, checked
// against the SHA-256 of the exact files this was tested with, and kept in memory. If that fails
// the caller falls back to a plain text message.
import { initWasm, Resvg } from '@resvg/resvg-wasm';

type Asset = { path: string; sha256: string };

const WASM: Asset = {
  path: '@resvg/resvg-wasm@2.6.2/index_bg.wasm',
  sha256: '22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70',
};
const FONTS: Asset[] = [
  {
    path: '@expo-google-fonts/onest@0.4.2/500Medium/Onest_500Medium.ttf',
    sha256: '7f4df8b6c91aa53bf5ccea5616e211327dce372f038f437be9da6fb1c820bbd1',
  },
  {
    path: '@expo-google-fonts/onest@0.4.2/800ExtraBold/Onest_800ExtraBold.ttf',
    sha256: 'ebd5f96376fd79ec5df39597fffb1a8feec706dafc238364baa179d6da4ba5a9',
  },
];

/** Mirrors of the npm registry; CARD_ASSETS_BASE (used by the local preview script) is tried first. */
function bases(): string[] {
  const custom = Deno.env.get('CARD_ASSETS_BASE');
  return [...(custom ? [custom.replace(/\/+$/, '')] : []), 'https://cdn.jsdelivr.net/npm', 'https://unpkg.com'];
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function download(asset: Asset): Promise<Uint8Array> {
  let lastError: unknown = new Error('no source');
  for (const base of bases()) {
    try {
      const res = await fetch(`${base}/${asset.path}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if ((await sha256Hex(bytes)) !== asset.sha256) throw new Error('checksum mismatch');
      return bytes;
    } catch (e) {
      lastError = new Error(`${base}/${asset.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw lastError;
}

let ready: Promise<Uint8Array[]> | null = null;
let wasmLoaded = false;

function load(): Promise<Uint8Array[]> {
  ready ??= (async () => {
    const [wasm, ...fonts] = await Promise.all([wasmLoaded ? null : download(WASM), ...FONTS.map(download)]);
    if (wasm) {
      await initWasm(wasm);
      wasmLoaded = true;
    }
    return fonts as Uint8Array[];
  })().catch((e) => {
    ready = null; // try again on the next card
    throw e;
  });
  return ready;
}

/** Draws an SVG built by lib/cards.ts. Takes about a second in a fresh worker, far less afterwards. */
export async function renderPng(svg: string): Promise<Uint8Array> {
  const fontBuffers = await load();
  const resvg = new Resvg(svg, { font: { fontBuffers, defaultFontFamily: 'Onest' }, fitTo: { mode: 'original' } });
  try {
    const image = resvg.render();
    try {
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}
