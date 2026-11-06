"use client";

import { useId } from "react";
import Editor from "react-simple-code-editor";
import Prism from "prismjs";
import "prismjs/components/prism-markdown";
import "./markdown-editor.css";

interface MarkdownEditorProps {
  /**
   * Accessible name for the textarea. Required: the editor renders a bare
   * textarea, and a heading next to it does not name it (axe `label`, #1300).
   */
  label: string;
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

export function MarkdownEditor({ label, value, onChange, className }: MarkdownEditorProps) {
  const textareaId = useId();
  return (
    <div className={`rounded-md border border-input bg-background ${className ?? ""}`}>
      <label htmlFor={textareaId} className="sr-only">
        {label}
      </label>
      <Editor
        textareaId={textareaId}
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
