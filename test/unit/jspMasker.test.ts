import { describe, expect, it } from "vitest";
import { declaredTaglibPrefixes, maskJsp, scanElEnd, type JspMaskOptions } from "../../src/preprocess/jspMasker";

/** Masks and checks the position-preservation invariant on every call. */
function m(src: string, opts?: JspMaskOptions) {
  const r = maskJsp(src, opts);
  expect(r.text.length, "same length").toBe(src.length);
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\n" || ch === "\r") expect(r.text[i], `line break kept at ${i}`).toBe(ch);
    else expect(r.text[i] === "\n" || r.text[i] === "\r", `no new line break at ${i}`).toBe(false);
  }
  return r;
}
const t = (src: string, opts?: JspMaskOptions) => m(src, opts).text;
const sp = (n: number) => " ".repeat(n);

describe("JSP comments, directives and scriptlets", () => {
  it("blanks JSP comments, even ones containing %> and tags", () => {
    const src = "<p>a</p><%-- <div> %> ${x} --%><p>b</p>";
    expect(t(src)).toBe(`<p>a</p>${sp(23)}<p>b</p>`);
  });

  it("blanks directives", () => {
    const src = '<%@ page contentType="text/html; charset=UTF-8" %>\n<p>x</p>';
    expect(t(src)).toBe(`${sp(50)}\n<p>x</p>`);
  });

  it("blanks declarations and scriptlets", () => {
    expect(t("<%! int a = 1; %><p>x</p><% a++; %>")).toBe(`${sp(17)}<p>x</p>${sp(10)}`);
  });

  it("keeps line breaks in multi-line scriptlets (LF and CRLF)", () => {
    const src = "<ul>\n<% for (Item i : items) {\r\n   if (i.ok()) { %>\n<li>x</li>\n<% } } %>\n</ul>";
    const out = t(src);
    expect(out.split(/\r?\n/)).toEqual(["<ul>", sp("<% for (Item i : items) {".length), sp(19), "<li>x</li>", sp(9), "</ul>"]);
  });

  it("masks an unterminated scriptlet to the end of the file", () => {
    expect(t("<p>a</p><% if (x) {\n<p>b</p>")).toBe(`<p>a</p>${sp(11)}\n${sp(8)}`);
  });

  it("keeps HTML exactly as written around JSP", () => {
    const html = '<table class="t"><tr><td>1</td></tr></table>\n<img src="a.png">\n<center>c</center>';
    expect(t(`<%@ page import="java.util.*" %>${html}<% x(); %>`)).toBe(`${sp(32)}${html}${sp(10)}`);
  });
});

describe("expressions and EL", () => {
  it("fills EL inside attribute values with a non-empty placeholder", () => {
    const out = t('<a href="${url}">x</a>');
    expect(out).toMatch(/^<a href="x+[a-z]">x<\/a>$/);
    expect(out.length).toBe(22);
  });

  it("gives every placeholder a distinct value so ids do not collide", () => {
    const out = t('<input id="${a}"><input id="${b}">');
    const ids = [...out.matchAll(/id="([^"]+)"/g)].map((x) => x[1]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids.every((v) => v?.length === 4 && /^[a-z]+$/.test(v))).toBe(true);
  });

  it("handles <%= %> in attributes, including quotes inside the Java code", () => {
    const out = t('<img src="<%= m.get("logo") %>" alt="">');
    expect(out).toMatch(new RegExp(`^<img src="[a-z]{${'<%= m.get("logo") %>'.length}}" alt="">$`));
  });

  it("handles unquoted attribute values made of EL", () => {
    const r = m("<a href=${u}>x</a>");
    expect(r.text).toMatch(/^<a href=[a-z]{4}>x<\/a>$/);
    expect(r.maskedAttributes).toEqual([{ name: "href", tagStart: 0, valueStart: 8, valueEnd: 12 }]);
  });

  it("records attributes whose value contains a placeholder", () => {
    const r = m('<input type="${t}" value="static" class="a ${b}">');
    expect(r.maskedAttributes.map((a) => a.name)).toEqual(["type", "class"]);
  });

  it("handles nested braces and strings containing braces in EL", () => {
    expect(scanElEnd('${fn:join(a, "}")} rest', 2)).toBe(18);
    expect(scanElEnd("${ {1, {2}} } rest", 2)).toBe(13);
    expect(scanElEnd("${'it\\'s }'} rest", 2)).toBe(12);
    expect(t('<p title="${fn:join(a, "}")}">x</p>')).toMatch(/^<p title="[a-z]{18}">x<\/p>$/);
  });

  it("supports deferred #{} expressions", () => {
    expect(t('<p class="#{bean.cls}">x</p>')).toMatch(new RegExp(`^<p class="[a-z]{${"#{bean.cls}".length}}">x</p>$`));
  });

  it("leaves escaped \\${...} and unterminated ${ alone", () => {
    expect(t("<p>\\${not.el}</p>")).toBe("<p>\\${not.el}</p>");
    expect(t("<p>${broken</p>")).toBe("<p>${broken</p>");
  });

  it("uses spaces for EL inside attribute-less tag positions", () => {
    expect(t('<input ${disabled ? "disabled" : ""} name="n">')).toBe(`<input ${sp(29)} name="n">`);
  });

  it("uses a placeholder where text is allowed and spaces where it is not", () => {
    expect(t("<title>${t}</title>")).toMatch(/^<title>[a-z]{4}<\/title>$/);
    expect(t("<td>${v}</td>")).toMatch(/^<td>[a-z]{4}<\/td>$/);
    expect(t("<ul>${items}</ul>")).toBe(`<ul>${sp(8)}</ul>`);
    expect(t("<table>${rows}</table>")).toBe(`<table>${sp(7)}</table>`);
    expect(t("${top}<p>x</p>")).toBe(`${sp(6)}<p>x</p>`);
  });

  it("uses spaces inside <script> and <style>", () => {
    expect(t("<script>var a = ${json};</script>")).toBe(`<script>var a = ${sp(7)};</script>`);
    expect(t("<style>p{color:${c}}</style>")).toBe(`<style>p{color:${sp(4)}}</style>`);
  });

  it("does not treat markup inside <script> as tags", () => {
    const r = m('<script>var s = "<body>";</script><p>${x}</p>', { stripDocumentStructure: true });
    expect(r.text.startsWith('<script>var s = "<body>";</script><p>')).toBe(true);
  });
});

describe("custom tags", () => {
  it("strips custom tag markup but keeps the body", () => {
    const src = '<table><c:forEach items="${rows}" var="r"><tr><td>${r.name}</td></tr></c:forEach></table>';
    const out = t(src);
    expect(out.startsWith(`<table>${sp(35)}<tr><td>`)).toBe(true);
    expect(out.endsWith(`</td></tr>${sp(12)}</table>`)).toBe(true);
  });

  it("handles > inside quoted custom-tag attributes", () => {
    expect(t('<c:if test="${a > b}"><p>x</p></c:if>')).toBe(`${sp(22)}<p>x</p>${sp(7)}`);
    expect(t("<c:if test='<%= a > b %>'><p>x</p></c:if>")).toBe(`${sp(26)}<p>x</p>${sp(7)}`);
  });

  it("strips self-closing custom tags and jsp: actions", () => {
    expect(t('<p><fmt:message key="k"/></p><jsp:include page="h.jsp"/>')).toBe(`<p>${sp(22)}</p>${sp(27)}`);
  });

  it("uses a placeholder for a custom tag inside an attribute value", () => {
    const r = m("<img src=\"<c:url value='/logo.png'/>\" alt=\"\">");
    expect(r.text).toMatch(/^<img src="[a-z]{26}" alt="">$/);
    expect(r.maskedAttributes[0]?.name).toBe("src");
  });

  it("recognises prefixes declared by taglib directives and from options", () => {
    const src = '<%@ taglib prefix="my" uri="/WEB-INF/my.tld" %><my:box><p>x</p></my:box><z:w>keep</z:w>';
    expect(declaredTaglibPrefixes(src)).toEqual(["my"]);
    expect(t(src)).toBe(`${sp(47)}${sp(8)}<p>x</p>${sp(9)}<z:w>keep</z:w>`);
    expect(t("<z:w>a</z:w>", { customTagPrefixes: ["z"] })).toBe(`${sp(5)}a${sp(6)}`);
  });

  it("blanks the Java body of <jsp:scriptlet>", () => {
    expect(t("<jsp:scriptlet>if (a < b) { x(); }</jsp:scriptlet><p>x</p>")).toBe(`${sp(50)}<p>x</p>`);
  });

  it("keeps line breaks in multi-line custom tags", () => {
    expect(t('<c:if\n  test="${x}">\n<p>x</p>\n</c:if>')).toBe(`${sp(5)}\n${sp('  test="${x}">'.length)}\n<p>x</p>\n${sp(7)}`);
  });
});

describe("document structure", () => {
  const page = '<!DOCTYPE html>\n<html lang="de">\n<head><title>T</title></head>\n<body onload="${x}">\n<p>x</p>\n</body>\n</html>';

  it("keeps structure tags by default and reports what it saw", () => {
    const r = m(page);
    expect(r.text.split("\n")[0]).toBe("<!DOCTYPE html>");
    expect([r.hasDoctype, r.hasHtmlElement, r.hasTitle]).toEqual([true, true, true]);
  });

  it("blanks <!DOCTYPE>, <html>, <head>, <body> start and end tags when asked", () => {
    const lines = t(page, { stripDocumentStructure: true }).split("\n");
    expect(lines).toEqual([sp(15), sp(16), `${sp(6)}<title>T</title>${sp(7)}`, sp(20), "<p>x</p>", sp(7), sp(7)]);
  });

  it("is case-insensitive", () => {
    expect(t("<!doctype HTML><HTML><BODY>x</BODY></HTML>", { stripDocumentStructure: true })).toBe(`${sp(27)}x${sp(14)}`);
  });

  it("does not touch structure-like text in HTML comments", () => {
    expect(t("<!-- <body> -->x", { stripDocumentStructure: true })).toBe("<!-- <body> -->x");
  });

  it("detects meta charset", () => {
    expect(m('<meta charset="utf-8">').hasMetaCharset).toBe(true);
    expect(m('<meta name="x" content="y">').hasMetaCharset).toBe(false);
  });
});
