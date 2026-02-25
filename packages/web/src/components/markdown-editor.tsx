"use client";

import Editor from "react-simple-code-editor";
import Prism from "prismjs";
import "prismjs/components/prism-markdown";
import "./markdown-editor.css";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

function highlightMarkdown(code: string): string {
  if (!Prism.languages.markdown) {
    return code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  return Prism.highlight(code, Prism.languages.markdown, "markdown");
}

export function MarkdownEditor({ value, onChange, className }: MarkdownEditorProps) {
  return (
    <div className={`rounded-md border border-input bg-background ${className ?? ""}`}>
      <Editor
        value={value}
        onValueChange={onChange}
        highlight={highlightMarkdown}
        padding={12}
        className="markdown-editor font-mono text-sm min-h-[15rem] [&_textarea]:outline-none"
        textareaClassName="focus:outline-none"
      />
    </div>
  );
}
