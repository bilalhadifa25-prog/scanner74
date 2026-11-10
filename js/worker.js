import { detectQuad, warp, rotate, applyFilter, downscale } from './imaging.js';

self.onmessage = (e) => {
  const { id, op, img } = e.data;
  try {
    if (op === 'detect') {
      self.postMessage({ id, result: detectQuad(img) });
    } else if (op === 'process') {
      const { quad, rotation = 0, filter = 'original', adjust, maxSide = 2400 } = e.data;
      let out = warp(img, quad, maxSide);
      out = rotate(out, rotation);
      out = applyFilter(out, filter, adjust);
      self.postMessage({ id, result: out }, [out.data.buffer]);
    } else if (op === 'filter') {
      // quick previews on an already-cropped image
      const { filter, adjust, maxSide = 900 } = e.data;
      const small = downscale(img, maxSide).img;
      const out = applyFilter(small, filter, adjust);
      self.postMessage({ id, result: out }, [out.data.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
