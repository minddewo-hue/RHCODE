Repair and finish the current core implementation. Work directly with tools and finish with passing tests.

Important Windows encoding constraint:

- Every `.js` source file must contain ASCII bytes only. Express all Chinese UI/error strings with JavaScript `\uXXXX` escapes. Do not place literal Chinese in source files.
- Use PowerShell-compatible commands only. For multiline ASCII content, `Set-Content -Encoding UTF8` with a single-quoted here-string is allowed. Do not embed Python inside PowerShell. Do not use shell redirection.
- The existing files may contain corrupted replacement characters. Replace or repair them rather than trusting their current text.

Required result:

- ESM package with `npm test` using `node --test` and `npm start` using `node src/server.js`.
- Strict CSV parser for date/code/name/close/change_pct/volume/amount and optional category, with escaped Chinese errors for empty input, missing columns, invalid dates/numbers, and duplicate date+code.
- Pure analysis modules for equal-weight normalized sector index, SMA, momentum, RSI14, annualized volatility, max drawdown, volume ratio, breadth, advance ratio, transparent trend score/label/contributions, four required risk signals, stock relative strength/filter/sort.
- Deterministic demo dataset with at least 130 weekdays and 8 stocks across five compute-chain categories; no Math.random.
- Node tests covering every feature and boundaries.
- Run `npm test`; run `node --check` for every JS file; scan all JS bytes/text and confirm no U+FFFD replacement character and no non-ASCII bytes. Fix all failures.

Do not develop the browser UI in this turn. Keep the implementation concise and finish the core instead of repeatedly discussing encoding.
