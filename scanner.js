/* scanner.js
   Barcode helpers for DJ Nutrition Tracker.
   Nothing in this file touches the camera or the network when it loads. */
(function (root) {
  'use strict';

  var API = 'https://world.openfoodfacts.org/api/v2/product/';
  var FIELDS = 'code,product_name,generic_name,brands,serving_size,serving_quantity,nutriments';

  /* ---- numbers ---- */
  function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return isFinite(n) && n >= 0 ? n : null;
  }

  /* ---- barcode numbers ---- */
  function digitsOnly(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

  // True when the last digit matches the others (GTIN-8, UPC-A and EAN-13 all use the same rule).
  function gtinOk(code) {
    var n = code.length, sum = 0;
    for (var i = 0; i < n - 1; i++) {
      sum += Number(code.charAt(n - 2 - i)) * (i % 2 === 0 ? 3 : 1);
    }
    return (10 - (sum % 10)) % 10 === Number(code.charAt(n - 1));
  }

  // UPC-E is a short form of UPC-A used on small packages. Expand it to the 12-digit form.
  function expandUpcE(c) {
    var ns = c.charAt(0);
    if (ns !== '0' && ns !== '1') return null;
    var x = c.slice(1, 7), chk = c.charAt(7), last = x.charAt(5), a;
    if ('012'.indexOf(last) > -1) a = ns + x[0] + x[1] + last + '0000' + x[2] + x[3] + x[4];
    else if (last === '3') a = ns + x[0] + x[1] + x[2] + '00000' + x[3] + x[4];
    else if (last === '4') a = ns + x[0] + x[1] + x[2] + x[3] + '00000' + x[4];
    else a = ns + x[0] + x[1] + x[2] + x[3] + x[4] + '0000' + last;
    return a + chk;
  }

  // Returns a clean 8, 12 or 13 digit code, or null when the number is not a valid barcode.
  function normalizeCode(raw) {
    var c = digitsOnly(raw), n = c.length;
    if (n === 8) {
      if (gtinOk(c)) return c;
      var up = expandUpcE(c);
      return up && gtinOk(up) ? up : null;
    }
    if (n === 12 || n === 13) return gtinOk(c) ? c : null;
    return null;
  }

  // The database stores US codes with a leading zero, so try that form first.
  function lookupCandidates(code) {
    return code.length === 12 ? ['0' + code, code] : [code];
  }

  /* ---- turning a database product into the numbers the form needs ---- */
  function parseProduct(p, code) {
    if (!p || typeof p !== 'object') return null;
    var n = p.nutriments && typeof p.nutriments === 'object' ? p.nutriments : {};
    var qty = toNum(p.serving_quantity);
    if (!(qty > 0)) qty = null;

    var hasServing = ['energy-kcal_serving', 'energy-kj_serving', 'proteins_serving', 'carbohydrates_serving', 'fat_serving']
      .some(function (k) { return toNum(n[k]) !== null; });
    var basis = (qty || hasServing) ? 'serving' : '100g';

    // One nutrient on the chosen basis. A bare key such as "proteins" is the per 100 g value.
    function get(key) {
      var s = toNum(n[key + '_serving']);
      var h = toNum(n[key + '_100g']);
      if (h === null) h = toNum(n[key]);
      if (basis === 'serving') {
        if (s !== null) return s;
        if (h !== null && qty) return h * qty / 100;
        return null;
      }
      return h;
    }

    var kcal = get('energy-kcal');
    if (kcal === null) {                       // some products only list kilojoules
      var kj = get('energy-kj');
      if (kj === null) kj = get('energy');
      if (kj !== null) kcal = kj / 4.184;
    }
    var sodiumG = get('sodium');               // stored in grams
    if (sodiumG === null) {
      var saltG = get('salt');
      if (saltG !== null) sodiumG = saltG / 2.5;
    }

    function r0(v) { return v === null ? 0 : Math.round(v); }
    function r1(v) { return v === null ? 0 : Math.round(v * 10) / 10; }

    var nm = String(p.product_name || p.generic_name || '').trim();
    var brand = String(p.brands || '').split(',')[0].trim();
    var name = nm ? ((brand && nm.toLowerCase().indexOf(brand.toLowerCase()) === -1) ? brand + ' ' + nm : nm) : (brand || 'Scanned food');

    return {
      code: code,
      name: name.slice(0, 80),
      servingText: String(p.serving_size || '').trim().slice(0, 40),
      basis: basis,
      hasNutrition: kcal !== null || get('proteins') !== null || get('carbohydrates') !== null || get('fat') !== null,
      vals: {
        cal: r0(kcal), p: r1(get('proteins')), c: r1(get('carbohydrates')), f: r1(get('fat')),
        fiber: r1(get('fiber')), sugar: r1(get('sugars')), sodium: r0(sodiumG === null ? null : sodiumG * 1000)
      }
    };
  }

  /* ---- the lookup (the only network call in the app) ---- */
  // Resolves to a parsed product, or null when the database does not have it.
  // Rejects with err.code "network" or "http" when it could not get an answer.
  function lookup(code, fetchFn, timeoutMs) {
    var list = lookupCandidates(code), idx = 0;
    function next() {
      if (idx >= list.length) return Promise.resolve(null);
      var c = list[idx++];
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 10000) : null;
      return fetchFn(API + encodeURIComponent(c) + '.json?fields=' + FIELDS, ctrl ? { signal: ctrl.signal } : undefined)
        .then(function (res) {
          if (timer) clearTimeout(timer);
          if (res.status === 404) return null;
          if (!res.ok) { var e = new Error('http ' + res.status); e.code = 'http'; throw e; }
          return res.json();
        }, function () {
          if (timer) clearTimeout(timer);
          var e = new Error('network'); e.code = 'network'; throw e;
        })
        .then(function (json) {
          if (json && (json.status === 1 || json.status === '1') && json.product) return parseProduct(json.product, c);
          return next();
        });
    }
    return next();
  }

  /* ---- reading a barcode from a grayscale camera frame (used when the browser has no built-in detector) ---- */
  function makeDecoder(Z) {
    var hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    var reader = new Z.MultiFormatReader();
    reader.setHints(hints);
    return function decodeGray(gray, w, h) {
      try {
        var bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(gray, w, h)));
        return reader.decodeWithState(bitmap).getText();
      } catch (e) { return null; }
    };
  }

  var api = {
    normalizeCode: normalizeCode, lookupCandidates: lookupCandidates, parseProduct: parseProduct,
    lookup: lookup, makeDecoder: makeDecoder, gtinOk: gtinOk, expandUpcE: expandUpcE
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DJScan = api;
})(typeof self !== 'undefined' ? self : this);
