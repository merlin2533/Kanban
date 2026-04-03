#!/usr/bin/env node
/**
 * Simple build script: minifies CSS and JS files into a /public/dist directory.
 * No external dependencies required — uses regex-based minification.
 *
 * Usage:  node build.js
 *         npm run build
 *
 * Output: public/dist/app.min.js, public/dist/card.min.js, public/dist/style.min.css
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DIST_DIR = path.join(PUBLIC_DIR, 'dist');

if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// CSS minifier — removes comments, collapses whitespace
// ---------------------------------------------------------------------------
function minifyCSS(src) {
  return src
    // Remove block comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Remove line breaks and leading/trailing spaces
    .replace(/\s*\n\s*/g, ' ')
    // Collapse multiple spaces
    .replace(/\s{2,}/g, ' ')
    // Remove spaces around punctuation that doesn't need them
    .replace(/\s*([{}:;,>~+])\s*/g, '$1')
    // Remove last semicolon before closing brace
    .replace(/;}/g, '}')
    .trim();
}

// ---------------------------------------------------------------------------
// JS minifier — removes single-line and block comments, collapses whitespace.
// Intentionally conservative: preserves strings and regex literals.
// ---------------------------------------------------------------------------
function minifyJS(src) {
  let result = '';
  let i = 0;
  const len = src.length;

  while (i < len) {
    const ch = src[i];

    // String literals: preserve exactly
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      result += ch;
      i++;
      while (i < len) {
        const c = src[i];
        if (c === '\\') {
          result += c + (src[i + 1] || '');
          i += 2;
          continue;
        }
        if (quote === '`' && c === '$' && src[i + 1] === '{') {
          // Template literal expression — just copy through naively until matching }
          result += c;
          i++;
          continue;
        }
        result += c;
        i++;
        if (c === quote) break;
      }
      continue;
    }

    // Single-line comment
    if (ch === '/' && src[i + 1] === '/') {
      // Skip until end of line
      while (i < len && src[i] !== '\n') i++;
      // Keep a newline to avoid merging tokens
      result += '\n';
      continue;
    }

    // Block comment
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < len && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2; // skip */
      result += ' ';
      continue;
    }

    // Regular characters — collapse whitespace
    if (ch === '\n' || ch === '\r') {
      // Replace with space, but avoid double spaces
      if (result.length && result[result.length - 1] !== ' ' && result[result.length - 1] !== '\n') {
        result += ' ';
      }
      i++;
      continue;
    }

    result += ch;
    i++;
  }

  return result
    // Collapse runs of spaces (but not inside strings — already processed)
    .replace(/[ \t]{2,}/g, ' ')
    // Remove spaces around operators and punctuation that don't need them
    .replace(/ ?([{};,]) ?/g, '$1')
    .replace(/ ?([\]]) ?/g, '$1')
    .replace(/ ?([\[]) ?/g, '$1')
    .replace(/ ?(=>) ?/g, '=>')
    // Remove leading/trailing whitespace
    .trim();
}

// ---------------------------------------------------------------------------
// Process files
// ---------------------------------------------------------------------------
const jsFiles = ['app.js', 'card.js'];
const cssFiles = ['style.css'];

let totalSaved = 0;

for (const file of jsFiles) {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  const minified = minifyJS(src);
  const outName = file.replace('.js', '.min.js');
  const outPath = path.join(DIST_DIR, outName);
  fs.writeFileSync(outPath, minified, 'utf8');
  const saved = src.length - minified.length;
  totalSaved += saved;
  console.log(`[JS]  ${file} → dist/${outName}  (${src.length} → ${minified.length} bytes, -${Math.round(saved / src.length * 100)}%)`);
}

for (const file of cssFiles) {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  const minified = minifyCSS(src);
  const outName = file.replace('.css', '.min.css');
  const outPath = path.join(DIST_DIR, outName);
  fs.writeFileSync(outPath, minified, 'utf8');
  const saved = src.length - minified.length;
  totalSaved += saved;
  console.log(`[CSS] ${file} → dist/${outName}  (${src.length} → ${minified.length} bytes, -${Math.round(saved / src.length * 100)}%)`);
}

console.log(`\nDone. Total saved: ${(totalSaved / 1024).toFixed(1)} KB`);
