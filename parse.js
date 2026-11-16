// parse.js — a fast, dependency-free drop-in for marked 18.1.3's
// marked.parse() with the default options (gfm on, breaks off, pedantic off).
//
// Design: a direct-rendering port of marked's lexer/tokenizer/renderer.
// No token objects and no AST are built: block parsing renders straight to
// HTML pieces, and inline runs render straight to HTML too. The only
// deferred work is the inline runs of block-level constructs (paragraphs,
// headings, table cells, ...), which are queued and rendered after the
// whole block pass so that link reference definitions anywhere in the
// document are visible to them, exactly like marked's inline queue.
//
// Grammar regexes are derived from marked 18.1.3's rules (MIT, markedjs).

// Small builder for composing big regexes out of named fragments. When a
// fragment regex is spliced in, a leading ^ anchor is stripped, because
// the fragment is no longer at the start of the pattern.
const CARET = /(^|[^\[])\^/g;
function edit(regex, opt = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  const obj = {
    replace(name, val) {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(CARET, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex() {
      return new RegExp(source, opt);
    },
  };
  return obj;
}

// The indented-list "begin" regexes only ever need 0..3 leading spaces:
// marked clamps the indent to that range, so cache the four variants.
function cachedIndentRegex(createRegex) {
  const cache = [];
  return (indent) => {
    const cacheIndex = Math.max(0, Math.min(3, indent - 1));
    let regex = cache[cacheIndex];
    if (!regex) {
      regex = createRegex(cacheIndex);
      cache[cacheIndex] = regex;
    }
    return regex;
  };
}

const _tag = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

// Shared small patterns, mirroring marked's `other`.
const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  setextContinuationLine: /^ {0,3}(?:=+|-+) *$/,
  leadingThreeSpaces: /^ {0,3}/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${_tag})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}>`)),
};

// ---------------------------------------------------------------------------
// Block grammar (GFM). Built the same way marked builds it, so the final
// patterns are identical to marked 18.1.3's block.gfm.
// ---------------------------------------------------------------------------

const _newline = /^(?:[ \t]*(?:\n|$))+/;
const _blockCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const _fences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const _hr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const _heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const _bullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const _lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const _lheading = edit(_lheadingCore)
  .replace(/bull/g, _bullet)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();
const _paragraphCore = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const _blockText = /^[^\n]+/;
const _blockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const _def = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', _blockLabel)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();
const _list = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, _bullet)
  .getRegex();
const _comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const _html = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' // (1)
  + '|comment[^\\n]*(\\n+|$)' // (2)
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' // (3)
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' // (4)
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' // (5)
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (6)
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (7) open tag
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (7) closing tag
  + ')', 'i')
  .replace('comment', _comment)
  .replace('tag', _tag)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();
const _gfmTable = edit(
  '^ *([^\\n ].*)\\n' // Header
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)' // Align
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)') // Cells
  .replace('hr', _hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();

function makeParagraph(listInterrupt) {
  return edit(_paragraphCore)
    .replace('hr', _hr)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listInterrupt)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', _tag)
    .getRegex();
}
// Only non-empty lists starting from 1 can interrupt paragraphs.
const _paragraph = edit(_paragraphCore)
  .replace('hr', _hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', _gfmTable)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();
// Inside a blockquote a bare list marker (any number) starts a sibling list.
const _blockquoteParagraph = makeParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
const _blockquote = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', _blockquoteParagraph)
  .getRegex();

// Cheap necessary conditions, used to skip the two big multi-line block
// regexes. A setext underline must start a later line (before the first
// blank line, which the heading content cannot span) with = or -, and a
// table delimiter row must start the second line with |, : or -.
function lheadingHint(src) {
  let i = src.indexOf('\n');
  while (i !== -1) {
    const j = i + 1;
    let k = j;
    while (src[k] === ' ' || src[k] === '\t') k++;
    if (src[k] === '\n' || k >= src.length) return false;
    let p = j;
    let spaces = 0;
    while (spaces < 3 && src[p] === ' ') { p++; spaces++; }
    if (src[p] === '=' || src[p] === '-') return true;
    i = src.indexOf('\n', k);
  }
  return false;
}
function tableHint(src) {
  const nl = src.indexOf('\n');
  if (nl < 0) return false;
  let i = nl + 1;
  let spaces = 0;
  while (spaces < 3 && src[i] === ' ') { i++; spaces++; }
  const ch = src[i];
  return ch === '|' || ch === ':' || ch === '-';
}

// ---------------------------------------------------------------------------
// Inline grammar (GFM). Same construction as marked's inline.gfm.
// ---------------------------------------------------------------------------

const _escape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const _inlineCode = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const _br = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const _punctuation = /[\p{P}\p{S}]/u;
const _punctuationOrSpace = /[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpace = /[^\s\p{P}\p{S}]/u;
const _punctuationGfm = /(?!~)[\p{P}\p{S}]/u;
const _punctuationOrSpaceGfm = /(?!~)[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpaceGfm = /(?:[^\s\p{P}\p{S}]|~)/u;
const _punctuationRe = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, _punctuationOrSpace).getRegex();

// Sequences em/strong skip over: [title](link), `code`, <html>.
const _blockSkip = edit(/link|(?<!`)()code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

const _emStrongLDelimCore = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const _emStrongLDelim = edit(_emStrongLDelimCore, 'u')
  .replace(/punct/g, _punctuationGfm)
  .getRegex();

const _emStrongRDelimAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // Skip orphan inside strong
  + '|[^*]+(?=[^*])' // Consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only be a Right Delimiter
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only be a Right Delimiter
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only be Left Delimiter
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only be Left Delimiter
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either Left or Right Delimiter
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either Left or Right Delimiter
const _emStrongRDelimAst = edit(_emStrongRDelimAstCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpaceGfm)
  .replace(/punctSpace/g, _punctuationOrSpaceGfm)
  .replace(/punct/g, _punctuationGfm)
  .getRegex();
const _emStrongRDelimUnd = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // Skip orphan inside strong
  + '|[^_]+(?=[^_])' // Consume to delim
  + '|(?!_)punct(_+)(?=[\\s]|$)' // (1) #___ can only be a Right Delimiter
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2) a___#, a___ can only be a Right Delimiter
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3) #___a, ___a can only be Left Delimiter
  + '|[\\s](_+)(?!_)(?=punct)' // (4) ___# can only be Left Delimiter
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu') // (5) #___# can be either Left or Right Delimiter
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();

const _delLDelim = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, _punctuation)
  .getRegex();
const _delRDelim = edit(
  '^[^~]+(?=[^~])' // Consume to delim
  + '|(?!~)punct(~~?)(?=[\\s]|$)' // (1) #~~ can only be a Right Delimiter
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' // (2) a~~#, a~~ can only be a Right Delimiter
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)' // (3) #~~a, ~~a can only be Left Delimiter
  + '|[\\s](~~?)(?!~)(?=punct)' // (4) ~~# can only be Left Delimiter
  + '|(?!~)punct(~~?)(?!~)(?=punct)' // (5) #~~# can be either Left or Right Delimiter
  + '|notPunctSpace(~~?)(?=notPunctSpace)', 'gu') // (6) a~~a can be either Left or Right Delimiter
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();

const _anyPunctuation = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();
// Like _anyPunctuation, but a backslash inside a code span is literal, so
// code spans are matched whole and kept; only escapes outside them count.
const _anyPunctuationOutsideCode = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();

const _autolink = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();

const _inlineComment = edit(_comment).replace('(?:-->|$)', '-->').getRegex();
const _tagRe = edit(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' // self-closing tag
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>' // open tag
  + '|^<\\?[\\s\\S]*?\\?>' // processing instruction, e.g. <?php ?>
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>' // declaration, e.g. <!DOCTYPE html>
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>') // CDATA section
  .replace('comment', _inlineComment)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();

const _inlineLabelBrackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const _inlineLabel = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();
const _link = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', _inlineLabel)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();
const _reflink = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', _inlineLabel)
  .replace('ref', _blockLabel)
  .getRegex();
const _nolink = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', _blockLabel)
  .getRegex();

// Bounded-label variants for the O(n^2)-prone global reflink search.
const _boundedBlockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const _boundedInlineLabel = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();
const _reflinkSearch = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', _boundedInlineLabel)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .getRegex();

const _caseInsensitiveProtocol = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const _extendedEmail = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const _extendedEmailProtocol = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, _extendedEmail)
  .getRegex();
const _url = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', _extendedEmailProtocol)
  .replace('protocol', _caseInsensitiveProtocol)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();
const _backpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const _del = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const _inlineText = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', _caseInsensitiveProtocol)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .getRegex();

// A run with none of these characters and no hard break, www., :// or @
// cannot start any inline construct, so it renders as one text token.
const _plainRunChars = /[\\<[*!_`~@]/;

// ---------------------------------------------------------------------------
// Small string helpers (marked's helpers.ts, same behavior).
// ---------------------------------------------------------------------------

const _escapeReplacements = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function _escapeReplacement(ch) {
  return _escapeReplacements[ch];
}
// encode=true escapes every & < > " '; otherwise an & that already starts
// a character reference (named or numeric) is left alone.
function escapeHtml(html, encode) {
  if (encode) {
    if (O.escapeTest.test(html)) return html.replace(O.escapeReplace, _escapeReplacement);
  } else if (O.escapeTestNoEncode.test(html)) {
    return html.replace(O.escapeReplaceNoEncode, _escapeReplacement);
  }
  return html;
}
// Numeric character references stand for the character they name (zero,
// out of range, or a surrogate becomes U+FFFD). Every other & is escaped
// here so a decoded character cannot join its neighbours into a new
// reference.
function decodeNumericRefs(text) {
  if (!O.numericCharacterReference.test(text)) return text;
  return text.replace(O.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(O.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}
function splitCells(tableRow, count) {
  const row = tableRow.replace(O.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(O.splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(O.slashPipe, '|');
  }
  return cells;
}
// Remove trailing 'c's (or, with invert, trailing non-c chars).
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}
function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && O.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str; // keep a single trailing blank line
  return lines.slice(0, end + 1).join('\n');
}
// Link labels match after trimming, collapsing inner whitespace to one
// space, and a Unicode case fold (lower -> upper -> lower).
function normalizeLabel(label) {
  return label.trim().replace(O.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}
// Index of the bracket that closes the unbalanced opener, -1 when balanced
// (or no brackets at all), -2 when more openers than closers remain.
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}
function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}
// Last indexes of `*` / `_` / `~` runs that can close emphasis, strong or
// strikethrough in one masked inline source. A run can close only when it
// is not preceded by ASCII whitespace or the start of the string. Scanned
// once per inline run and shared by every opener in it.
function scanClosers(src) {
  const last = { '*': -1, '_': -1, '~': -1 };
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      last[ch] = i;
    }
    i = j - 1;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Inline engine, part 1: masking, link checks, links/images.
// ---------------------------------------------------------------------------
// Per-parse mutable state (S): links, queue, inLink, inRawBlock,
// linkEmitted, linkParenPossible. Inline tokenizers return { len, html }
// (or null for no match); a reflink that resolves to nothing returns
// { len: 1, text: '[' | '!' } instead, to be merged into the text run.

// Does this link text already hold a link? An image does not count: an
// image may hold a link, a link may not.
function linkInText(S, text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(_blockSkip)) {
    if (_link.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(_reflinkSearch)) {
    const m0 = match[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!' || !Object.hasOwn(S.links, normalizeLabel(m0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(S, m0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

// Mask links, code spans, html and escapes so emStrong and del do not see
// delimiters inside them. Every mask keeps the length it replaces, because
// emStrong/del line the masked source up with the real one by slicing
// from the end.
function maskSrc(S, src) {
  let masked = src;
  if (src.includes('[')) {
    const maskReflink = (m0) => {
      const refStart = m0.lastIndexOf('[');
      if (!Object.hasOwn(S.links, normalizeLabel(m0.slice(refStart + 1, -1)))) return m0;
      if (refStart > 1 && m0.charAt(0) !== '!') {
        const text = m0.slice(1, refStart - 1);
        if (linkInText(S, text)) {
          return '[' + text.replace(_reflinkSearch, maskReflink)
            + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m0.length - 2) + ']';
    };
    masked = masked.replace(_reflinkSearch, maskReflink);
  }
  // The escape mask only changes something when the run holds a
  // backslash or a backtick; the block mask only when it holds a '[',
  // a backtick or a '<'. Skip the scans otherwise.
  if (masked.includes('\\') || masked.includes('`')) {
    masked = masked.replace(_anyPunctuationOutsideCode, (m0, code, punct) => {
      if (punct) return '+'.repeat(m0.length);
      if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return m0;
    });
  }
  if (masked.includes('[') || masked.includes('`') || masked.includes('<')) {
    masked = masked.replace(_blockSkip, (m0) => '[' + 'a'.repeat(m0.length - 2) + ']');
  }
  return masked;
}

// True when the label's closing bracket sits inside an html tag or
// autolink that runs past the label's end, so the link is not a link.
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = _inlineCode.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = _tagRe.exec(tokenSrc) || _autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Renders a link or image once its label/href/title are known. The label
// is rendered in a nested inline run; a link whose label holds another
// link is not a link at all (images are exempt). textMode renders the
// plain-text form used for image alt text.
function outputLink(S, cap, link, raw, textMode) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(O.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = S.inLink;
  const outerLinkEmitted = S.linkEmitted;
  const outerInRawBlock = S.inRawBlock;
  S.inLink = true;
  S.linkEmitted = false;
  const inner = inlineRun(S, text, isImage ? true : textMode);
  const textHasLink = S.linkEmitted;
  S.linkEmitted = outerLinkEmitted;
  S.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      // These tokens are discarded, so undo the raw-block state they
      // opened; leaving it set would suppress escaping for the text
      // that is re-scanned as plain text.
      S.inRawBlock = outerInRawBlock;
      return null;
    }
    S.linkEmitted = true;
    if (textMode) return { len: raw.length, html: inner };
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) return { len: raw.length, html: inner };
    let out = '<a href="' + escapeHtml(cleanHref) + '"';
    if (title) out += ' title="' + escapeHtml(title) + '"';
    out += '>' + inner + '</a>';
    return { len: raw.length, html: out };
  }
  if (textMode) return { len: raw.length, html: inner };
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { len: raw.length, html: escapeHtml(inner) };
  let out = '<img src="' + escapeHtml(cleanHref) + '" alt="' + escapeHtml(inner) + '"';
  if (title) out += ' title="' + escapeHtml(title) + '"';
  out += '>';
  return { len: raw.length, html: out };
}

// Inline link: [text](href "title") or ![alt](src). The link regex
// backtracks quadratically over unterminated-link inputs, so the run's
// linkParenPossible flag (false when the run holds no ')') bails out
// before running it.
function tokLink(S, src, textMode) {
  if (S.linkParenPossible === false) return null;
  const cap = _link.exec(src);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return null;
  const trimmedUrl = cap[2].trim();
  if (trimmedUrl.charAt(0) === '<') {
    if (trimmedUrl.charAt(trimmedUrl.length - 1) !== '>') return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  // The ')' ending the match is the link closer only when it is not
  // escaped: `[foo](/url\)` has no closer; that paren is destination text.
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;
  let href = cap[2];
  let title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (href.charAt(0) === '<') href = href.slice(1, -1);
  return outputLink(S, cap, {
    href: href ? href.replace(_anyPunctuation, '$1') : href,
    title: title ? title.replace(_anyPunctuation, '$1') : title,
  }, cap[0], textMode);
}

// Reference link [text][ref], collapsed [text][] or shortcut [text].
// A reference with no definition renders its first character as text.
function tokReflink(S, src, textMode) {
  const cap = _reflink.exec(src) || _nolink.exec(src);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return null;
  const link = S.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const text = cap[0].charAt(0);
    return { len: 1, text };
  }
  return outputLink(S, cap, link, cap[0], textMode);
}

// Emphasis and strong. Follows marked's delimiter-run algorithm
// (CommonMark rules 9-10 included): the opener's run length counts the
// whole run, even the part already consumed as text, and a mid-run opener
// only pairs with a delimiter that can only close.
function tokEmStrong(S, src, masked, closers, prevChar, textMode) {
  let match = _emStrongLDelim.exec(src);
  if (!match) return null;
  const nextCp = match[1] || match[2] || match[3] || match[4];
  if (!nextCp) return null;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = masked.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!_punctuationRe.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!_punctuationRe.exec(prevChar);
  // _ can't be between two alphanumerics.
  if (match[4] && O.unicodeAlphaNumeric.test(prevChar)) return null;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = match[0].length - nextCp.length;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    const endReg = delimChar === '*' ? _emStrongRDelimAst : _emStrongRDelimUnd;
    const lastPossible = closers[delimChar];
    const windowStart = masked.length - src.length + lLength;
    if (lastPossible < windowStart) return null;
    const window = masked.slice(-1 * src.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(window)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue; // skip single * in __abc*abc__
      rLength = rDelim.length;
      if (match[3] || match[4]) { // found another Left Delim
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) { // either Left or Right Delim
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue; // CommonMark Emphasis Rules 9-10
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue; // haven't found enough closing delimiters
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = window.codePointAt(match.index) > 0xFFFF ? 2 : 1;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const inner = inlineRun(S, raw.slice(1, -1), textMode);
        return { len: raw.length, html: textMode ? inner : '<em>' + inner + '</em>' };
      }
      const inner = inlineRun(S, raw.slice(2, -2), textMode);
      return { len: raw.length, html: textMode ? inner : '<strong>' + inner + '</strong>' };
    }
  }
  return null;
}

// Strikethrough, the same shape as emStrong but without the run rules:
// the closer must have exactly the opener's length.
function tokDel(S, src, masked, closers, prevChar, textMode) {
  let match = _delLDelim.exec(src);
  if (!match) return null;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || _punctuationRe.exec(prevChar)) {
    const lLength = match[0].charAt(1) === '~' ? 2 : 1;
    let rDelim, rLength, delimTotal = lLength;
    const endReg = _delRDelim;
    const lastPossible = closers['~'];
    const windowStart = masked.length - src.length + lLength;
    if (lastPossible < windowStart) return null;
    const window = masked.slice(-1 * src.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(window)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = rDelim.length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) { // found another Left Delim
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = window.codePointAt(match.index) > 0xFFFF ? 2 : 1;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const inner = inlineRun(S, raw.slice(lLength, -lLength), textMode);
      return { len: raw.length, html: textMode ? inner : '<del>' + inner + '</del>' };
    }
  }
  return null;
}

// <scheme:...> and <email> autolinks. Autolinks escape their href and
// text fully (encode=true), unlike ordinary links.
function tokAutolink(src, textMode) {
  const cap = _autolink.exec(src);
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  if (textMode) return { len: cap[0].length, html: text };
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { len: cap[0].length, html: escapeHtml(text, true) };
  return { len: cap[0].length, html: '<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(text, true) + '</a>' };
}

// Extended autolinks: www., http(s)://, ftp://, bare emails, mailto:/xmpp:.
function tokUrl(src, textMode) {
  const cap = _url.exec(src);
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      cap[0] = _backpedal.exec(cap[0])?.[0] ?? '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  if (textMode) return { len: cap[0].length, html: text };
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { len: cap[0].length, html: escapeHtml(text, true) };
  return { len: cap[0].length, html: '<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(text, true) + '</a>' };
}

// Inline HTML tag. Toggling <a> and <pre>/<code>/<kbd>/<script> state is
// part of tokenizing, so it happens in both render modes.
function tokTag(S, src) {
  const cap = _tagRe.exec(src);
  if (!cap) return null;
  if (!S.inLink && O.startATag.test(cap[0])) S.inLink = true;
  else if (S.inLink && O.endATag.test(cap[0])) S.inLink = false;
  if (!S.inRawBlock && O.startPreScriptTag.test(cap[0])) S.inRawBlock = true;
  else if (S.inRawBlock && O.endPreScriptTag.test(cap[0])) S.inRawBlock = false;
  return { len: cap[0].length, html: cap[0] };
}

function tokCodespan(src, textMode) {
  const cap = _inlineCode.exec(src);
  if (!cap) return null;
  let text = cap[2].replace(O.newLineCharGlobal, ' ');
  const hasNonSpaceChars = O.nonSpaceChar.test(text);
  const hasSpaceCharsOnBothEnds = text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ';
  if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
  return { len: cap[0].length, html: textMode ? text : '<code>' + escapeHtml(text, true) + '</code>' };
}

function tokBr(src, textMode) {
  const cap = _br.exec(src);
  if (!cap) return null;
  return { len: cap[0].length, html: textMode ? '' : '<br>' };
}

function tokEscape(src, textMode) {
  const cap = _escape.exec(src);
  if (!cap) return null;
  const ch = cap[1];
  return { len: cap[0].length, html: textMode ? ch : (_escapeReplacements[ch] || ch) };
}

function tokInlineText(S, src) {
  const cap = _inlineText.exec(src);
  const escaped = S.inRawBlock;
  return {
    len: cap[0].length,
    raw: cap[0],
    text: escaped ? cap[0] : decodeNumericRefs(cap[0]),
    escaped,
  };
}

// Renders one inline run straight to HTML (or plain text for image alt
// text). Adjacent text pieces are buffered and escaped together, because
// marked merges adjacent text tokens before escaping and the &-lookahead
// in the escaper reads across the join.
function inlineRun(S, src, textMode) {
  if (!_plainRunChars.test(src) && !src.includes('  \n') && !src.includes('www.') && !src.includes('://')) {
    if (S.inRawBlock) return src;
    const decoded = decodeNumericRefs(src);
    return textMode ? decoded : escapeHtml(decoded);
  }
  const hasDelims = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = hasDelims ? maskSrc(S, src) : src;
  const closers = hasDelims ? scanClosers(masked) : null;
  const prevLinkParenPossible = S.linkParenPossible;
  S.linkParenPossible = prevLinkParenPossible && src.includes(')');
  let out = '';
  let textBuf = '';
  let textEscaped = false;
  let hasText = false;
  const flushText = () => {
    if (!hasText) return;
    if (textMode || textEscaped) out += textBuf;
    else out += escapeHtml(textBuf);
    textBuf = '';
    hasText = false;
  };
  let keepPrevChar = false;
  let prevChar = '';
  try {
    while (src) {
      if (!keepPrevChar) prevChar = '';
      keepPrevChar = false;
      const c = src[0];
      let tok = null;
      if (c === '\\') {
        tok = tokEscape(src, textMode);
        if (tok) { flushText(); out += tok.html; src = src.slice(tok.len); continue; }
        tok = tokBr(src, textMode);
        if (tok) { flushText(); out += tok.html; src = src.slice(tok.len); continue; }
      } else if (c === '<') {
        tok = tokTag(S, src);
        if (tok) { flushText(); out += tok.html; src = src.slice(tok.len); continue; }
        tok = tokAutolink(src, textMode);
        if (tok) { flushText(); out += tok.html; src = src.slice(tok.len); continue; }
      } else if (c === '[' || c === '!') {
        tok = tokLink(S, src, textMode);
        if (tok) { flushText(); out += tok.html; src = src.slice(tok.len); continue; }
        const r = tokReflink(S, src, textMode);
        if (r) {
          if (r.text !== undefined) {
            if (!hasText) { textEscaped = false; hasText = true; }
            textBuf += r.text;
            src = src.slice(1);
            continue;
          }
          flushText(); out += r.html; src = src.slice(r.len); continue;
        }
      } else if (c === '*' || c === '_') {
        tok = tokEmStrong(S, src, masked, closers, prevChar, textMode);
        if (tok) { flushText(); out += tok.html; src = src.slice(tok.len); continue; }
      } else if (c === '`') {
        tok = tokCodespan(src, textMode);
        if (tok) { flushText(); out += tok.html; src = src.slice(tok.len); continue; }
      } else if (c === ' ') {
        tok = tokBr(src, textMode);
        if (tok) { flushText(); out += tok.html; src = src.slice(tok.len); continue; }
      } else if (c === '~') {
        tok = tokDel(S, src, masked, closers, prevChar, textMode);
        if (tok) { flushText(); out += tok.html; src = src.slice(tok.len); continue; }
      }
      if (!S.inLink && (c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c === '.' || c === '_' || c === '+' || c === '-')) {
        tok = tokUrl(src, textMode);
        if (tok) { flushText(); out += tok.html; src = src.slice(tok.len); continue; }
      }
      const t = tokInlineText(S, src);
      if (!hasText) { textEscaped = t.escaped; hasText = true; }
      textBuf += t.text;
      if (t.raw.charAt(t.raw.length - 1) !== '_') prevChar = t.raw.charAt(t.raw.length - 1);
      keepPrevChar = true;
      src = src.slice(t.len);
    }
  } finally {
    S.linkParenPossible = prevLinkParenPossible;
  }
  flushText();
  return out;
}

// ---------------------------------------------------------------------------
// Block layer. A block context (ctx) holds one token list's output pieces
// plus the bookkeeping marked keeps on its token list: the last token's
// type/raw/text/job (paragraph merging and code/def absorption need them),
// the first token (task checkboxes need it), the direct text jobs (loose
// lists turn them into paragraphs) and whether a pushed space token
// spanned two newlines (loose-list detection).
// ---------------------------------------------------------------------------

function newCtx(top) {
  return {
    out: [],
    top,
    clipped: false,
    lastType: '',
    lastRaw: '',
    lastText: '',
    lastJob: null,
    lastStart: 0,
    firstType: '',
    firstJob: null,
    textJobs: [],
    multiSpace: false,
  };
}

// Queue a deferred inline run. The job is rendered after the whole block
// pass (see parse), when every link definition is known.
function queueInline(S, src, pre, post) {
  const job = { src, pre, post, prefix: '', html: '' };
  S.queue.push(job);
  return job;
}

function pushToken(ctx, type, raw, pieces) {
  const wasFirst = ctx.firstType === '';
  ctx.lastStart = ctx.out.length;
  for (let i = 0; i < pieces.length; i++) ctx.out.push(pieces[i]);
  ctx.lastType = type;
  ctx.lastRaw = raw;
  ctx.lastJob = null;
  ctx.lastText = '';
  if (wasFirst) ctx.firstType = type;
  return wasFirst;
}

// Resolve a flat piece list to its HTML once every job is rendered.
function flatten(out) {
  const parts = new Array(out.length);
  for (let i = 0; i < out.length; i++) {
    const piece = out[i];
    parts[i] = typeof piece === 'string' ? piece : piece.pre + piece.prefix + piece.html + piece.post;
  }
  return parts.join('');
}

function indentCodeCompensation(raw, text) {
  const m = raw.match(O.indentCodeCompensation);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mn = node.match(O.beginningSpace);
    if (mn === null) return node;
    return node.slice(Math.min(mn[0].length, indentToCode.length));
  }).join('\n');
}

function tokSpace(src, ctx) {
  const cap = _newline.exec(src);
  if (!cap || cap[0].length === 0) return 0;
  const raw = cap[0];
  if (raw.length === 1 && ctx.lastType !== '') {
    // A single \n as a spacer terminates the last line: move it there.
    ctx.lastRaw += '\n';
  } else {
    const wasFirst = ctx.firstType === '';
    ctx.lastStart = ctx.out.length;
    ctx.lastType = 'space';
    ctx.lastRaw = raw;
    ctx.lastJob = null;
    ctx.lastText = '';
    if (wasFirst) ctx.firstType = 'space';
    if (raw.indexOf('\n') !== raw.lastIndexOf('\n')) ctx.multiSpace = true;
  }
  return raw.length;
}

function tokCode(src, ctx) {
  const cap = _blockCode.exec(src);
  if (!cap) return 0;
  const raw = trimTrailingBlankLines(cap[0]);
  const text = raw.replace(O.codeRemoveIndent, '');
  if (ctx.lastType === 'paragraph' || ctx.lastType === 'text') {
    // An indented code block cannot interrupt a paragraph: it is absorbed.
    ctx.lastRaw += (ctx.lastRaw.endsWith('\n') ? '' : '\n') + raw;
    ctx.lastText += '\n' + text;
    ctx.lastJob.src = ctx.lastText;
    return raw.length;
  }
  const code = text ? text.replace(O.endingNewline, '') + '\n' : '';
  pushToken(ctx, 'code', raw, ['<pre><code>' + escapeHtml(code, true) + '</code></pre>\n']);
  return raw.length;
}

function tokFences(src, ctx) {
  const cap = _fences.exec(src);
  if (!cap) return 0;
  const raw = cap[0];
  const text = indentCodeCompensation(raw, cap[3] || '');
  const lang = cap[2] ? cap[2].trim().replace(_anyPunctuation, '$1') : cap[2];
  const code = text ? text.replace(O.endingNewline, '') + '\n' : '';
  const langString = (lang || '').match(O.notSpaceStart)?.[0];
  const html = !langString
    ? '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n'
    : '<pre><code class="language-' + escapeHtml(langString) + '">' + escapeHtml(code, true) + '</code></pre>\n';
  pushToken(ctx, 'code', raw, [html]);
  return raw.length;
}

function tokHeading(S, src, ctx) {
  const cap = _heading.exec(src);
  if (!cap) return 0;
  let text = cap[2].trim();
  if (O.endingHash.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || O.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
  }
  const raw = rtrim(cap[0], '\n');
  const depth = cap[1].length;
  const job = queueInline(S, text, '<h' + depth + '>', '</h' + depth + '>\n');
  pushToken(ctx, 'heading', raw, [job]);
  return raw.length;
}

function tokHr(src, ctx) {
  const cap = _hr.exec(src);
  if (!cap) return 0;
  const raw = rtrim(cap[0], '\n');
  pushToken(ctx, 'hr', raw, ['<hr>\n']);
  return raw.length;
}

function tokHtml(src, ctx) {
  const cap = _html.exec(src);
  if (!cap) return 0;
  const raw = trimTrailingBlankLines(cap[0]);
  pushToken(ctx, 'html', raw, [raw]);
  return raw.length;
}

function tokDef(S, src, ctx) {
  const cap = _def.exec(src);
  if (!cap) return 0;
  // Outside angle brackets a link destination holds only balanced parens.
  if (cap[2].charAt(0) !== '<' && findClosingBracket(cap[2], '()') !== -1) return 0;
  const tag = normalizeLabel(cap[1]);
  const href = cap[2] ? cap[2].replace(O.hrefBrackets, '$1').replace(_anyPunctuation, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(_anyPunctuation, '$1') : cap[3];
  const raw = rtrim(cap[0], '\n');
  if (ctx.lastType === 'paragraph' || ctx.lastType === 'text') {
    ctx.lastRaw += (ctx.lastRaw.endsWith('\n') ? '' : '\n') + raw;
    ctx.lastText += '\n' + raw;
    ctx.lastJob.src = ctx.lastText;
    return raw.length;
  }
  // The first definition of a label wins, but a later one still consumes
  // its text. A def renders nothing but is still a token.
  if (!S.links[tag]) S.links[tag] = { href, title: title || null };
  const wasFirst = ctx.firstType === '';
  ctx.lastStart = ctx.out.length;
  ctx.lastType = 'def';
  ctx.lastRaw = raw;
  ctx.lastJob = null;
  ctx.lastText = '';
  if (wasFirst) ctx.firstType = 'def';
  return raw.length;
}

function tokTable(S, src, ctx) {
  const cap = _gfmTable.exec(src);
  if (!cap) return 0;
  // The delimiter row must have a pipe or colon, or this is a setext heading.
  if (!O.tableDelimiter.test(cap[2])) return 0;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(O.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(O.tableRowBlankLine, '').split('\n') : [];
  if (headers.length !== aligns.length) return 0;
  const align = new Array(aligns.length);
  for (let i = 0; i < aligns.length; i++) {
    if (O.tableAlignRight.test(aligns[i])) align[i] = 'right';
    else if (O.tableAlignCenter.test(aligns[i])) align[i] = 'center';
    else if (O.tableAlignLeft.test(aligns[i])) align[i] = 'left';
    else align[i] = null;
  }
  const pieces = ['<table>\n<thead>\n<tr>\n'];
  for (let i = 0; i < headers.length; i++) {
    const tag = align[i] ? '<th align="' + align[i] + '">' : '<th>';
    pieces.push(queueInline(S, headers[i], tag, '</th>\n'));
  }
  pieces.push('</tr>\n</thead>\n');
  if (rows.length > 0) {
    pieces.push('<tbody>');
    for (const row of rows) {
      pieces.push('<tr>\n');
      const cells = splitCells(row, headers.length);
      for (let i = 0; i < cells.length; i++) {
        const tag = align[i] ? '<td align="' + align[i] + '">' : '<td>';
        pieces.push(queueInline(S, cells[i], tag, '</td>\n'));
      }
      pieces.push('</tr>\n');
    }
    pieces.push('</tbody>');
  }
  pieces.push('</table>\n');
  const raw = rtrim(cap[0], '\n');
  pushToken(ctx, 'table', raw, pieces);
  return raw.length;
}

function tokLheading(S, src, ctx) {
  const cap = _lheading.exec(src);
  if (!cap) return 0;
  const text = cap[1].trim();
  const raw = rtrim(cap[0], '\n');
  const depth = cap[2].charAt(0) === '=' ? 1 : 2;
  const job = queueInline(S, text, '<h' + depth + '>', '</h' + depth + '>\n');
  pushToken(ctx, 'heading', raw, [job]);
  return raw.length;
}

// A paragraph merges into a preceding paragraph when this block pass is a
// blockquote continuation (lastParagraphClipped). The just-queued job is
// dropped and the previous job's source grows.
function tokParagraph(S, src, ctx) {
  const cap = _paragraph.exec(src);
  if (!cap) return 0;
  const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
  const job = queueInline(S, text, '<p>', '</p>\n');
  if (ctx.clipped && ctx.lastType === 'paragraph') {
    S.queue.pop();
    ctx.lastRaw += (ctx.lastRaw.endsWith('\n') ? '' : '\n') + cap[0];
    ctx.lastText += '\n' + text;
    ctx.lastJob.src = ctx.lastText;
    return cap[0].length;
  }
  const wasFirst = pushToken(ctx, 'paragraph', cap[0], [job]);
  if (wasFirst) ctx.firstJob = job;
  ctx.lastJob = job;
  ctx.lastText = text;
  return cap[0].length;
}

// Bare text: a single line, used where paragraphs are not top-level (list
// items). Consecutive text tokens merge into one.
function tokText(S, src, ctx) {
  const cap = _blockText.exec(src);
  if (!cap) return 0;
  const job = queueInline(S, cap[0], '', '');
  if (ctx.lastType === 'text') {
    S.queue.pop();
    ctx.lastRaw += (ctx.lastRaw.endsWith('\n') ? '' : '\n') + cap[0];
    ctx.lastText += '\n' + cap[0];
    ctx.lastJob.src = ctx.lastText;
    return cap[0].length;
  }
  const wasFirst = pushToken(ctx, 'text', cap[0], [job]);
  if (wasFirst) ctx.firstJob = job;
  ctx.lastJob = job;
  ctx.lastText = cap[0];
  ctx.textJobs.push(job);
  return cap[0].length;
}

// Block tokenizer dispatch, in marked's order. First-character checks
// skip the regexes that cannot match at this position.
function blockTokens(S, src, ctx, clipped) {
  ctx.clipped = clipped;
  while (src) {
    const c = src[0];
    let len = 0;
    if (c === ' ' || c === '\t' || c === '\n') {
      len = tokSpace(src, ctx);
      if (len) { src = src.slice(len); continue; }
    }
    if (c === ' ' || c === '\t') {
      len = tokCode(src, ctx);
      if (len) { src = src.slice(len); continue; }
    }
    if (c === ' ' || c === '`' || c === '~') {
      len = tokFences(src, ctx);
      if (len) { src = src.slice(len); continue; }
    }
    if (c === ' ' || c === '#') {
      len = tokHeading(S, src, ctx);
      if (len) { src = src.slice(len); continue; }
    }
    if (c === ' ' || c === '-' || c === '_' || c === '*') {
      len = tokHr(src, ctx);
      if (len) { src = src.slice(len); continue; }
    }
    if (c === ' ' || c === '>') {
      len = tokBlockquote(S, src, ctx);
      if (len) { src = src.slice(len); continue; }
    }
    if (c === ' ' || c === '*' || c === '+' || c === '-' || (c >= '0' && c <= '9')) {
      len = tokList(S, src, ctx);
      if (len) { src = src.slice(len); continue; }
    }
    if (c === ' ' || c === '<') {
      len = tokHtml(src, ctx);
      if (len) { src = src.slice(len); continue; }
    }
    if (c === ' ' || c === '[') {
      len = tokDef(S, src, ctx);
      if (len) { src = src.slice(len); continue; }
    }
    if (c !== '\n' && tableHint(src)) {
      len = tokTable(S, src, ctx);
      if (len) { src = src.slice(len); continue; }
    }
    if (lheadingHint(src)) {
      len = tokLheading(S, src, ctx);
      if (len) { src = src.slice(len); continue; }
    }
    if (ctx.top) {
      len = tokParagraph(S, src, ctx);
      if (len) { src = src.slice(len); continue; }
    }
    len = tokText(S, src, ctx);
    if (len) { src = src.slice(len); continue; }
    break; // unreachable: text always matches a non-empty source
  }
}

// The entry point: parse(markdown) returns exactly what marked 18.1.3's
// marked.parse returns with its defaults. Block parsing runs first (it
// collects link definitions and queues inline runs); the queued runs are
// then rendered in order, with inRawBlock reset before each, matching
// marked's inline queue drain.
export function parse(markdown) {
  const src = markdown.includes('\r') ? markdown.replace(O.carriageReturn, '\n') : markdown;
  const S = {
    links: Object.create(null),
    queue: [],
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
  };
  const ctx = newCtx(true);
  blockTokens(S, src, ctx, false);
  for (let i = 0; i < S.queue.length; i++) {
    const job = S.queue[i];
    // An inline <pre>/<code>/<kbd>/<script> left open ends with the block
    // holding it; carried over, it would stop every later block's text
    // from being escaped.
    S.inRawBlock = false;
    job.html = inlineRun(S, job.src, false);
  }
  return flatten(ctx.out);
}

// Blockquote. Lines are gathered in chunks: marked lines, then the lazy
// continuation lines that follow them, until a line that starts a new
// blockquote. Each chunk is re-tokenized as top-level blocks; a lazy
// continuation after a nested blockquote or list is folded back into
// that token by re-tokenizing it with the continuation lines.
function blockquoteParts(S, src) {
  const cap = _blockquote.exec(src);
  if (!cap) return null;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const inner = newCtx(true);
  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (O.blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);
    const currentRaw = currentLines.join('\n');
    let currentText = currentRaw;
    if (currentRaw.includes('\t')) {
      // A tab after the marker runs to the next tab stop, and the marker
      // only consumes one space of it; the rest is content.
      currentText = currentText.replace(
        O.blockquoteMarkerWhitespace,
        (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
      );
    }
    currentText = currentText
      // Precede a setext continuation with 4 spaces so it isn't a setext.
      .replace(O.blockquoteSetextReplace, '\n    $1')
      .replace(O.blockquoteSetextReplace2, '');
    raw = raw ? raw + '\n' + currentRaw : currentRaw;
    text = text ? text + '\n' + currentText : currentText;
    blockTokens(S, currentText, inner, true);
    if (lines.length === 0) break;
    const lastType = inner.lastType;
    if (lastType === 'code' || lastType === 'heading' || lastType === 'hr' || lastType === 'html' || lastType === 'table') {
      // A blockquote continuation cannot be preceded by these.
      break;
    } else if (lastType === 'blockquote') {
      const oldRaw = inner.lastRaw;
      const oldText = inner.lastText;
      const oldStart = inner.lastStart;
      const continuation = lines.join('\n');
      const newText = oldRaw + '\n' + continuation.replace(O.blockquoteSetextReplace2, '');
      const rebuilt = blockquoteParts(S, newText);
      inner.out.length = oldStart;
      for (const p of rebuilt.out) inner.out.push(p);
      inner.lastType = 'blockquote';
      inner.lastRaw = rebuilt.raw;
      inner.lastText = rebuilt.text;
      inner.lastJob = null;
      // Only include continuation lines the nested blockquote actually
      // consumed. Unconsumed trailing lines must stay out of `raw` so the
      // lexer can still tokenize them (paragraph, next blockquote, etc.).
      const leftover = newText.substring(rebuilt.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - oldText.length) + rebuilt.text;
      lines = lines.slice(consumed.length);
      // A leftover line that starts with '>' still belongs to this
      // blockquote; any other leftover line ends it.
      if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastType === 'list') {
      const oldRaw = inner.lastRaw;
      const oldStart = inner.lastStart;
      const newText = oldRaw + '\n' + lines.join('\n');
      const rebuilt = listParts(S, newText);
      inner.out.length = oldStart;
      for (const p of rebuilt.out) inner.out.push(p);
      inner.lastType = 'list';
      inner.lastRaw = rebuilt.raw;
      inner.lastText = '';
      inner.lastJob = null;
      // The list raw has no '>' markers, so it cannot be cut out of
      // `raw`. Count the continuation lines the list took and add those.
      const consumedCount = rebuilt.raw.length > oldRaw.length
        ? newText.slice(oldRaw.length + 1, rebuilt.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = raw + '\n' + consumed;
        text = text + '\n' + consumed;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
    // Any other last token: the loop continues with the remaining lines
    // as a new chunk, merging paragraphs across the boundary.
  }
  const out = ['<blockquote>\n', ...inner.out, '</blockquote>\n'];
  return { len: raw.length, raw, text, out };
}

function tokBlockquote(S, src, ctx) {
  const bq = blockquoteParts(S, src);
  if (!bq) return 0;
  pushToken(ctx, 'blockquote', bq.raw, bq.out);
  ctx.lastText = bq.text;
  return bq.len;
}

// First line of a string, without the line ending. Cheaper than
// str.split('\n', 1)[0] in the list item loop.
function firstLineOf(str) {
  const nl = str.indexOf('\n');
  return nl === -1 ? str : str.slice(0, nl);
}

// Does raw end with a blank line: \n, optional spaces/tabs, \n,
// optional spaces/tabs, end. (Same as /\n[ \t]*\n[ \t]*$/.)
function rawEndsWithBlankLine(raw) {
  let i = raw.length;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  if (i === 0 || raw[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  return i > 0 && raw[i - 1] === '\n';
}
function lineMarkerChar(line) {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  if (line[i] === ' ' || line[i] === '\t') return '';
  return line[i] || '';
}

// Lists. Items are gathered line by line (with the CommonMark nesting
// rules for what continues an item), then each item's text is tokenized
// as blocks with top=false, so its paragraphs are bare text tokens.
function listParts(S, src) {
  let cap = _list.exec(src);
  if (!cap) return null;
  const listSrc = src;
  const taken = () => listSrc.length - src.length;
  let bull = cap[1].trim();
  const isOrdered = bull.length > 1;
  const start = isOrdered ? +bull.slice(0, -1) : '';
  bull = isOrdered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = O.listItemRegex(bull);
  const items = [];
  let loose = false;
  let endsWithBlankLine = false;
  while (src) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(src))) break;
    if (_hr.test(src)) break; // End list if the bullet was actually an HR.
    const itemStart = taken();
    src = src.substring(cap[0].length);
    const firstLine = firstLineOf(cap[2]);
    const bulletIndent = cap[1].length;
    const line = firstLine.includes('\t')
      ? firstLine.replace(O.leadingSpaceTab, (whitespace) => expandTabs(whitespace, bulletIndent))
      : firstLine;
    let nextLine = firstLineOf(src);
    let blankLine = !line.trim();
    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(O.nonSpaceChar);
      indent = indent > 4 ? 1 : indent; // > 4 spaces is indented code: indent 1
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && O.blankLine.test(nextLine)) { // Items begin with at most one blank line
      src = src.substring(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const nextBulletRegex = O.nextBulletRegex(indent);
      const hrRegex = O.hrRegex(indent);
      const fencesBeginRegex = O.fencesBeginRegex(indent);
      const headingBeginRegex = O.headingBeginRegex(indent);
      const htmlBeginRegex = O.htmlBeginRegex(indent);
      const blockquoteBeginRegex = O.blockquoteBeginRegex(indent);
      let prevLine = line;
      while (src) {
        const rawLine = firstLineOf(src);
        nextLine = rawLine;
        const nextLineWithoutTabs = nextLine.includes('\t')
          ? nextLine.replace(O.leadingSpaceTab, (whitespace) => expandTabs(whitespace))
          : nextLine;
        const m = lineMarkerChar(nextLine);
        if (m === '`' || m === '~') {
          if (fencesBeginRegex.test(nextLine)) break;
        } else if (m === '#') {
          if (headingBeginRegex.test(nextLine)) break;
        } else if (m === '<') {
          if (htmlBeginRegex.test(nextLine)) break;
        } else if (m === '>') {
          if (blockquoteBeginRegex.test(nextLine)) break;
        } else if (m === '*' || m === '-') {
          if (nextBulletRegex.test(nextLine)) break;
          if (hrRegex.test(nextLine)) break;
        } else if (m === '+' || (m >= '0' && m <= '9')) {
          if (nextBulletRegex.test(nextLine)) break;
        } else if (m === '_') {
          if (hrRegex.test(nextLine)) break;
        }
        if (nextLineWithoutTabs.search(O.nonSpaceChar) >= indent || !nextLine.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          // Not enough indentation.
          if (blankLine) break;
          if ((prevLine.includes('\t') ? prevLine.replace(O.tabCharGlobal, '    ') : prevLine).search(O.nonSpaceChar) >= 4) break; // indented code
          if (fencesBeginRegex.test(prevLine)) break;
          if (headingBeginRegex.test(prevLine)) break;
          if (htmlBeginRegex.test(prevLine)) break;
          if (hrRegex.test(prevLine)) break;
          // A lazy continuation can look like a setext underline after
          // list indentation is removed. Keep it in the paragraph.
          const setextContinuation = O.setextContinuationLine.test(nextLine)
            && _lheading.test(prevLine + '\n' + nextLine);
          const continuation = setextContinuation
            ? '    ' + nextLineWithoutTabs.replace(O.leadingThreeSpaces, '')
            : nextLine;
          itemContents += '\n' + continuation;
        }
        blankLine = !nextLine.trim();
        src = src.substring(rawLine.length + 1);
        prevLine = nextLineWithoutTabs.slice(indent);
      }
    }
    const raw = listSrc.slice(itemStart, taken());
    if (!loose) {
      if (endsWithBlankLine) loose = true;
      else if (rawEndsWithBlankLine(raw)) endsWithBlankLine = true;
    }
    items.push({ raw, task: O.listIsTask.test(itemContents), text: itemContents });
  }
  const lastItem = items.at(-1);
  if (!lastItem) return null; // not a list since there were no items
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  const listRaw = listSrc.slice(0, taken()).trimEnd();
  return finishList(S, items, isOrdered, start, loose, listRaw);
}

// Tokenize each item's text, place task checkboxes, convert text tokens
// to paragraphs when the list is loose, and render the list.
function finishList(S, items, isOrdered, start, loose, listRaw) {
  for (const item of items) {
    const ictx = newCtx(false);
    blockTokens(S, item.text, ictx, false);
    item.ctx = ictx;
    if (!loose) loose = ictx.multiSpace;
  }
  for (const item of items) {
    const ictx = item.ctx;
    if (item.task && (ictx.firstType === 'text' || ictx.firstType === 'paragraph')) {
      // Remove the checkbox markdown from the item's inline run. Marked
      // searches the queue from the end for the last run that still
      // starts with a checkbox; do exactly that.
      for (let i = S.queue.length - 1; i >= 0; i--) {
        if (O.listIsTask.test(S.queue[i].src)) {
          S.queue[i].src = S.queue[i].src.replace(O.listReplaceTask, '');
          break;
        }
      }
      const taskRaw = O.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checked = taskRaw[0] !== '[ ]';
        const cb = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        if (loose) {
          ictx.firstJob.prefix = cb; // inside the first paragraph
        } else {
          ictx.out.unshift(cb);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (loose) {
    for (const item of items) {
      for (const job of item.ctx.textJobs) {
        job.pre = '<p>';
        job.post = '</p>\n';
      }
    }
  }
  const out = [isOrdered
    ? (start !== 1 ? '<ol start="' + start + '">\n' : '<ol>\n')
    : '<ul>\n'];
  for (const item of items) {
    out.push('<li>');
    for (const p of item.ctx.out) out.push(p);
    out.push('</li>\n');
  }
  out.push(isOrdered ? '</ol>\n' : '</ul>\n');
  return { len: listRaw.length, raw: listRaw, out };
}

function tokList(S, src, ctx) {
  const list = listParts(S, src);
  if (!list) return 0;
  pushToken(ctx, 'list', list.raw, list.out);
  return list.len;
}
