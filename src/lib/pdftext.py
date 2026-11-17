#!/usr/bin/env python
# PDF → 纯文本（PyMuPDF get_text），供 Node 采集器子进程调用：
#   python src/lib/pdftext.py <file.pdf>   →  stdout: 提取文本；失败 exit 3
import sys

def main():
    if len(sys.argv) < 2:
        print("usage: pdftext.py <file.pdf>", file=sys.stderr)
        sys.exit(2)
    try:
        import fitz  # PyMuPDF
    except ImportError:
        sys.exit(3)
    try:
        doc = fitz.open(sys.argv[1])
        out = []
        for page in doc:
            out.append(page.get_text())
        sys.stdout.write("\n<<<PAGE>>>\n".join(out))
    except Exception as e:
        print(f"pdf error: {e}", file=sys.stderr)
        sys.exit(4)

if __name__ == "__main__":
    main()
