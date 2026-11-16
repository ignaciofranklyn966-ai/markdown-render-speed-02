# markdown-render-speed-02

[![make.fun bounty](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ignaciofranklyn966-ai/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ignaciofranklyn966-ai/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A fast, dependency-free drop-in for marked 18.1.3, written for the
[Make Markdown rendering faster](https://make.fun/bounty/markdown-render-speed-02)
bounty on make.fun. `parse(markdown)` returns, for every string, exactly
the HTML that `marked.parse(markdown)` returns with marked's defaults
(GFM on, breaks off), and it does so about 1.6x faster than marked
itself on the practice set (720/720 cases identical).

## How it works

`parse.js` is a direct-rendering port of marked's lexer, tokenizer and
renderer: block parsing renders straight to HTML pieces and inline runs
render straight to HTML, with no token objects and no AST in between.
The only deferred work is the inline runs of block-level constructs
(paragraphs, headings, table cells), which are queued and rendered after
the whole block pass so that link reference definitions anywhere in the
document are visible to them, exactly like marked's inline queue.

The block and inline grammar regexes are derived from marked 18.1.3's
own rules; the renderer reproduces its output byte for byte, including
its edge cases (lazy blockquote continuations, list nesting, setext
underlines, emphasis delimiter runs, link nesting rules).

## Layout

- `parse.js` — the renderer: `export function parse(markdown)`.
- `main.ts` — the harness driver: reads `/input/cases.json`, renders
  each case alone with `parse()`, writes `/output/html.json`.

## Run it locally

```sh
MAKEFUN_INPUT_DIR=../kit/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

Node 22 or later, no install step, no dependencies.
