#!/usr/bin/env python3
"""
Render a statement document to PDF with WeasyPrint.

HTML arrives on stdin, the PDF leaves on stdout, so nothing touches a temp file
that would then have to be cleaned up on a serverless instance.

The paper size is passed here rather than written into the document: the
statement's own stylesheet declares `@page { margin: 0 }` and nothing else, which
is what keeps the running header and footer flush with the sheet edge. Page
margins would place them inside the page area instead, leaving a white band above
the header band.

Usage:
    render_statement.py --base-url <dir-with-fonts>/ > out.pdf
"""
import argparse
import sys

from weasyprint import CSS, HTML

PAGE = "@page { size: Letter }"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        required=True,
        help="Directory the document's relative URLs resolve against (the fonts).",
    )
    parser.add_argument(
        "--page-size",
        default="Letter",
        help="Paper size passed to WeasyPrint as a renderer stylesheet.",
    )
    args = parser.parse_args()

    html = sys.stdin.read()
    if not html.strip():
        print("render_statement: empty document on stdin", file=sys.stderr)
        return 2

    HTML(string=html, base_url=args.base_url).write_pdf(
        sys.stdout.buffer,
        stylesheets=[CSS(string=f"@page {{ size: {args.page_size} }}")],
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
