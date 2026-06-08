#!/usr/bin/env python3
"""
Mini GUI tool for generating KWS wake-word token files via:
  sherpa-onnx-cli text2token

Features
- Presets for common KWS models
- File pickers for tokens/lexicon/bpe/input/output
- Editable raw wake-word text area
- Command preview
- Run conversion and preview output
"""

from __future__ import annotations

import os
import shlex
import subprocess
import sys
import tempfile
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import filedialog, messagebox, scrolledtext, ttk


TOKENS_TYPES = [
    "cjkchar",
    "bpe",
    "cjkchar+bpe",
    "fpinyin",
    "ppinyin",
    "phone+ppinyin",
]

KWS_DOCS_URL = "https://k2-fsa.github.io/sherpa/onnx/kws/index.html"


DEFAULT_SAMPLE_INPUTS = {
    "ppinyin": (
        "你好问问 :2.0 #0.5 @你好问问\n"
        "小爱同学 :1.8 #0.4 @小爱同学\n"
    ),
    "phone+ppinyin": (
        "LIGHT UP @LIGHT_UP\n"
        "LOVELY CHILD @LOVELY_CHILD\n"
        "文森特卡索 @文森特卡索\n"
    ),
    "bpe": (
        "HELLO WORLD :1.5 #0.4\n"
        "HI GOOGLE :2.0 #0.8\n"
        "HEY SIRI #0.35\n"
    ),
}


class Text2TokenGUI:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("KWS Wake-Word Builder (sherpa-onnx-cli text2token)")
        self.root.geometry("1200x820")
        self.root.minsize(1024, 720)

        self.repo_root = Path(__file__).resolve().parents[1]

        self.preset_var = tk.StringVar(value="zh_en_phone_ppinyin")
        self.tokens_type_var = tk.StringVar(value="ppinyin")
        self.tokens_path_var = tk.StringVar()
        self.lexicon_path_var = tk.StringVar()
        self.bpe_model_path_var = tk.StringVar()
        self.input_path_var = tk.StringVar()
        self.output_path_var = tk.StringVar()
        self.status_var = tk.StringVar(value="Ready")
        self.format_hint_var = tk.StringVar()

        self._build_ui()
        self._apply_preset(self.preset_var.get())

    def _build_ui(self) -> None:
        frame = ttk.Frame(self.root, padding=10)
        frame.pack(fill=tk.BOTH, expand=True)

        cfg_frame = ttk.LabelFrame(frame, text="Configuration", padding=10)
        cfg_frame.pack(fill=tk.X)

        ttk.Label(cfg_frame, text="Preset").grid(row=0, column=0, sticky="w", padx=(0, 6), pady=4)
        preset_combo = ttk.Combobox(
            cfg_frame,
            textvariable=self.preset_var,
            state="readonly",
            values=["wenetspeech_zh", "gigaspeech_en", "zh_en_phone_ppinyin", "custom"],
            width=24,
        )
        preset_combo.grid(row=0, column=1, sticky="we", pady=4)
        preset_combo.bind("<<ComboboxSelected>>", lambda _: self._apply_preset(self.preset_var.get()))

        ttk.Label(cfg_frame, text="tokens-type").grid(row=0, column=2, sticky="w", padx=(12, 6), pady=4)
        ttk.Combobox(
            cfg_frame,
            textvariable=self.tokens_type_var,
            state="readonly",
            values=TOKENS_TYPES,
            width=20,
        ).grid(row=0, column=3, sticky="we", pady=4)

        self._path_row(cfg_frame, 1, "tokens.txt", self.tokens_path_var)
        self._path_row(cfg_frame, 2, "lexicon.txt (phone+ppinyin)", self.lexicon_path_var)
        self._path_row(cfg_frame, 3, "bpe.model (bpe/cjkchar+bpe)", self.bpe_model_path_var)
        self._path_row(cfg_frame, 4, "Input text file", self.input_path_var, save_dialog=True)
        self._path_row(cfg_frame, 5, "Output tokens file", self.output_path_var, save_dialog=True)

        cfg_frame.columnconfigure(1, weight=1)
        cfg_frame.columnconfigure(3, weight=1)

        main_panes = ttk.Panedwindow(frame, orient=tk.VERTICAL)
        main_panes.pack(fill=tk.BOTH, expand=True, pady=(10, 0))

        editor_frame = ttk.LabelFrame(main_panes, text="Wake-word Input (raw text)", padding=10)

        hint = (
            "Input format per line\n"
            "  <keyword phrase> [:boost] [#threshold] [@original_keyword]\n"
            "\n"
            "Examples\n"
            "  你好问问 :2.0 #0.5 @你好问问\n"
            "  小爱同学 :1.8 #0.4 @小爱同学\n"
            "  HELLO WORLD :1.5 #0.4\n"
        )
        ttk.Label(editor_frame, text=hint, foreground="#555", justify=tk.LEFT).pack(anchor="w")

        ref_frame = ttk.Frame(editor_frame)
        ref_frame.pack(fill=tk.X, pady=(4, 0))
        ttk.Label(ref_frame, text="Reference:").pack(side=tk.LEFT)
        docs_link = tk.Label(ref_frame, text=KWS_DOCS_URL, fg="#1a73e8", cursor="hand2")
        docs_link.pack(side=tk.LEFT, padx=(6, 0))
        docs_link.bind("<Button-1>", lambda _: self._open_reference_url())
        ttk.Button(ref_frame, text="Open Docs", command=self._open_reference_url).pack(side=tk.LEFT, padx=(8, 0))

        ttk.Label(
            editor_frame,
            textvariable=self.format_hint_var,
            foreground="#555",
            justify=tk.LEFT,
            wraplength=980,
        ).pack(anchor="w", pady=(6, 0))

        self.input_text = scrolledtext.ScrolledText(editor_frame, height=5, wrap=tk.WORD, undo=True)
        self.input_text.pack(fill=tk.BOTH, expand=True, pady=(6, 8))
        self._bind_copy_paste_shortcuts(self.input_text)
        self._attach_context_menu(self.input_text)

        lower_frame = ttk.Frame(main_panes)

        cmd_frame = ttk.LabelFrame(lower_frame, text="Command Preview", padding=10)
        cmd_frame.pack(fill=tk.X)

        self.cmd_preview = tk.Text(cmd_frame, height=2, wrap=tk.WORD)
        self.cmd_preview.pack(fill=tk.X)
        self.cmd_preview.config(state=tk.DISABLED)

        action_frame = ttk.Frame(lower_frame)
        action_frame.pack(fill=tk.X, pady=(10, 0))

        ttk.Button(action_frame, text="Refresh Command", command=self._refresh_command_preview).pack(side=tk.LEFT)
        ttk.Button(action_frame, text="Load Sample Input", command=lambda: self._load_default_sample_input(force=True)).pack(side=tk.LEFT, padx=(8, 0))
        ttk.Button(action_frame, text="Save Input", command=self._save_input_text_to_file).pack(side=tk.LEFT, padx=(8, 0))
        ttk.Button(action_frame, text="Run text2token", command=self._run_text2token).pack(side=tk.LEFT, padx=(8, 0))

        output_frame = ttk.LabelFrame(lower_frame, text="Execution Output / Feedback", padding=10)
        output_frame.pack(fill=tk.BOTH, expand=True, pady=(10, 0))

        output_action_frame = ttk.Frame(output_frame)
        output_action_frame.pack(fill=tk.X, pady=(0, 6))

        ttk.Button(output_action_frame, text="Copy Output", command=self._copy_output_text).pack(side=tk.LEFT)
        ttk.Button(output_action_frame, text="Clear Output", command=lambda: self._set_output_text("")).pack(side=tk.LEFT, padx=(8, 0))

        self.output_text = scrolledtext.ScrolledText(output_frame, height=18, wrap=tk.WORD, undo=True)
        self.output_text.pack(fill=tk.BOTH, expand=True)
        self._bind_copy_paste_shortcuts(self.output_text)
        self._attach_context_menu(self.output_text)

        main_panes.add(editor_frame, weight=2)
        main_panes.add(lower_frame, weight=3)

        status_bar = ttk.Label(frame, textvariable=self.status_var, anchor="w")
        status_bar.pack(fill=tk.X, pady=(8, 0))

        for var in [
            self.tokens_path_var,
            self.lexicon_path_var,
            self.bpe_model_path_var,
            self.input_path_var,
            self.output_path_var,
        ]:
            var.trace_add("write", lambda *_: self._refresh_command_preview())

        self.tokens_type_var.trace_add("write", lambda *_: self._on_tokens_type_changed())

        self._refresh_command_preview()
        self._refresh_format_hint()
        self._load_default_sample_input(force=False)
        self._set_output_text(
            "Ready. Click 'Run text2token' to see direct output here.\n"
            "The output panel will show command, exit code, stdout/stderr, and generated tokens."
        )

    def _path_row(self, parent: ttk.Frame, row: int, label: str, var: tk.StringVar, save_dialog: bool = False) -> None:
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", padx=(0, 6), pady=4)
        entry = ttk.Entry(parent, textvariable=var)
        entry.grid(row=row, column=1, columnspan=3, sticky="we", pady=4)

        def browse() -> None:
            initial = str(self.repo_root)
            if save_dialog:
                p = filedialog.asksaveasfilename(initialdir=initial)
            else:
                p = filedialog.askopenfilename(initialdir=initial)
            if p:
                var.set(p)

        ttk.Button(parent, text="Browse", command=browse).grid(row=row, column=4, padx=(6, 0), pady=4)

    def _preset_paths(self) -> dict[str, dict[str, str]]:
        base_models = self.repo_root / "models"
        return {
            "wenetspeech_zh": {
                "tokens_type": "ppinyin",
                "tokens": str(base_models / "kws" / "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01" / "tokens.txt"),
                "input": str(base_models / "kws" / "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01" / "keywords_raw.txt"),
                "output": str(base_models / "kws" / "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01" / "keywords.txt"),
            },
            "gigaspeech_en": {
                "tokens_type": "bpe",
                "tokens": str(base_models / "kws" / "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01" / "tokens.txt"),
                "bpe_model": str(base_models / "kws" / "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01" / "bpe.model"),
                "input": str(base_models / "kws" / "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01" / "keywords_raw.txt"),
                "output": str(base_models / "kws" / "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01" / "keywords.txt"),
            },
            "zh_en_phone_ppinyin": {
                "tokens_type": "phone+ppinyin",
                "tokens": str(base_models / "kws" / "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20" / "tokens.txt"),
                "lexicon": str(base_models / "kws" / "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20" / "en.phone"),
                "input": str(base_models / "kws" / "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20" / "keywords_raw.txt"),
                "output": str(base_models / "kws" / "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20" / "keywords.txt"),
            },
        }

    def _apply_preset(self, preset_name: str) -> None:
        if preset_name == "custom":
            self.status_var.set("Preset: custom")
            self._refresh_format_hint()
            self._refresh_command_preview()
            return

        preset = self._preset_paths().get(preset_name)
        if not preset:
            return

        self.tokens_type_var.set(preset.get("tokens_type", "ppinyin"))
        self.tokens_path_var.set(preset.get("tokens", ""))
        self.lexicon_path_var.set(preset.get("lexicon", ""))
        self.bpe_model_path_var.set(preset.get("bpe_model", ""))
        self.input_path_var.set(preset.get("input", ""))
        self.output_path_var.set(preset.get("output", ""))

        self._refresh_format_hint()
        self._refresh_command_preview()
        self._load_default_sample_input(force=False)
        self.status_var.set(f"Preset applied: {preset_name}")

    def _on_tokens_type_changed(self) -> None:
        self._refresh_format_hint()
        self._refresh_command_preview()

    def _refresh_format_hint(self) -> None:
        self.format_hint_var.set(self._format_hint_text())

    def _format_hint_text(self) -> str:
        tokens_type = self.tokens_type_var.get().strip() or "ppinyin"
        lines = [
            "Why the extra format:",
            "  :<float> is the boosting score. Larger values make the keyword easier to survive beam search.",
            "  #<float> is the trigger threshold. Lower values make the keyword easier to fire.",
            "  @<text> keeps the original keyword text in the generated output.",
        ]

        if tokens_type in {"fpinyin", "ppinyin", "phone+ppinyin"}:
            lines.extend([
                f"For {tokens_type}, sherpa-onnx expects @original_keyword on each non-empty line.",
                "If the original keyword contains spaces, replace them with underscores in the @ value.",
                "So plain text like '你好问问' is not the full recommended input for this mode.",
            ])
        else:
            lines.append(
                "Plain text is acceptable in this mode if you do not need per-keyword tuning values."
            )

        return "\n".join(lines)

    def _open_reference_url(self) -> None:
        try:
            webbrowser.open_new_tab(KWS_DOCS_URL)
            self.status_var.set("Opened sherpa-onnx KWS docs")
        except Exception as err:
            messagebox.showerror("Open docs failed", str(err))

    def _validate_input_text(self) -> None:
        tokens_type = self.tokens_type_var.get().strip()
        if tokens_type not in {"fpinyin", "ppinyin", "phone+ppinyin"}:
            return

        content = self.input_text.get("1.0", tk.END)
        invalid_lines = []
        for line_no, raw_line in enumerate(content.splitlines(), start=1):
            line = raw_line.strip()
            if not line:
                continue
            parts = line.split()
            if not any(part.startswith("@") and len(part) > 1 for part in parts):
                invalid_lines.append(f"Line {line_no}: {raw_line}")

        if invalid_lines:
            example = "你好问问 :2.0 #0.5 @你好问问"
            raise ValueError(
                "For fpinyin/ppinyin/phone+ppinyin, each non-empty line should include @original_keyword.\n\n"
                f"Example:\n{example}\n\n"
                "Invalid lines:\n" + "\n".join(invalid_lines[:8])
            )

    def _default_sample_for_current_tokens_type(self) -> str:
        tokens_type = self.tokens_type_var.get().strip()
        if tokens_type == "phone+ppinyin":
            return DEFAULT_SAMPLE_INPUTS["phone+ppinyin"]
        if tokens_type in {"bpe", "cjkchar+bpe"}:
            return DEFAULT_SAMPLE_INPUTS["bpe"]
        return DEFAULT_SAMPLE_INPUTS["ppinyin"]

    def _load_default_sample_input(self, force: bool = False) -> None:
        current = self.input_text.get("1.0", tk.END).strip()
        if current and not force:
            return

        sample = self._default_sample_for_current_tokens_type()
        self.input_text.delete("1.0", tk.END)
        self.input_text.insert("1.0", sample)

    def _set_output_text(self, text: str) -> None:
        self.output_text.delete("1.0", tk.END)
        self.output_text.insert("1.0", text)
        self.output_text.see("end")
        self.root.update_idletasks()

    def _append_output_text(self, text: str) -> None:
        existing = self.output_text.get("1.0", tk.END).rstrip("\n")
        combined = f"{existing}\n{text}" if existing else text
        self._set_output_text(combined)

    def _copy_output_text(self) -> None:
        text = self.output_text.get("1.0", tk.END).rstrip("\n")
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        self.status_var.set("Output copied to clipboard")

    def _attach_context_menu(self, text_widget: tk.Text) -> None:
        menu = tk.Menu(text_widget, tearoff=0)
        menu.add_command(label="Copy", command=lambda: text_widget.event_generate("<<Copy>>"))
        menu.add_command(label="Paste", command=lambda: text_widget.event_generate("<<Paste>>"))
        menu.add_command(label="Select All", command=lambda: self._select_all_text(text_widget))

        def show_menu(event: tk.Event) -> None:
            menu.tk_popup(event.x_root, event.y_root)

        text_widget.bind("<Button-3>", show_menu)

    def _bind_copy_paste_shortcuts(self, text_widget: tk.Text) -> None:
        text_widget.bind("<Control-a>", lambda e: self._select_all_text(text_widget, e))
        text_widget.bind("<Control-A>", lambda e: self._select_all_text(text_widget, e))

    def _select_all_text(self, text_widget: tk.Text, event: tk.Event | None = None) -> str:
        text_widget.tag_add("sel", "1.0", "end-1c")
        text_widget.mark_set("insert", "1.0")
        text_widget.see("insert")
        return "break"

    def _build_command(self, input_path: str, output_path: str) -> list[str]:
        cli = self._resolve_cli_executable()
        cmd = [
            cli,
            "text2token",
            "--tokens",
            self.tokens_path_var.get().strip(),
            "--tokens-type",
            self.tokens_type_var.get().strip(),
        ]

        tokens_type = self.tokens_type_var.get().strip()

        if tokens_type == "phone+ppinyin":
            lexicon = self.lexicon_path_var.get().strip()
            if not lexicon:
                raise ValueError("tokens-type is phone+ppinyin: lexicon.txt is required")
            cmd += ["--lexicon", lexicon]

        if tokens_type in {"bpe", "cjkchar+bpe"}:
            bpe_model = self.bpe_model_path_var.get().strip()
            if not bpe_model:
                raise ValueError("tokens-type is bpe/cjkchar+bpe: bpe.model is required")
            cmd += ["--bpe-model", bpe_model]

        cmd += [input_path, output_path]
        return cmd

    def _resolve_cli_executable(self) -> str:
        # Prefer the console script next to the current interpreter to avoid PATH issues.
        python_path = Path(sys.executable)
        candidate = python_path.parent / ("sherpa-onnx-cli.exe" if os.name == "nt" else "sherpa-onnx-cli")
        if candidate.exists():
            return str(candidate)
        return "sherpa-onnx-cli"

    def _refresh_command_preview(self) -> None:
        input_path = self.input_path_var.get().strip() or "<INPUT_FILE>"
        output_path = self.output_path_var.get().strip() or "<OUTPUT_FILE>"

        try:
            cmd = self._build_command(input_path, output_path)
            text = " ".join(shlex.quote(part) for part in cmd)
        except Exception as err:
            text = f"Invalid config: {err}"

        self.cmd_preview.config(state=tk.NORMAL)
        self.cmd_preview.delete("1.0", tk.END)
        self.cmd_preview.insert("1.0", text)
        self.cmd_preview.config(state=tk.DISABLED)

    def _save_input_text_to_file(self) -> None:
        input_path = self.input_path_var.get().strip()
        if not input_path:
            messagebox.showwarning("Missing path", "Please set Input text file path first")
            return

        content = self.input_text.get("1.0", tk.END).strip()
        Path(input_path).parent.mkdir(parents=True, exist_ok=True)
        Path(input_path).write_text(content + "\n", encoding="utf-8")
        self.status_var.set(f"Input saved: {input_path}")

    def _run_text2token(self) -> None:
        tokens = self.tokens_path_var.get().strip()
        output_path = self.output_path_var.get().strip()

        if not tokens:
            self.status_var.set("Validation failed: tokens.txt is missing")
            self._set_output_text("Validation error:\nPlease set tokens.txt path.")
            messagebox.showerror("Missing tokens", "Please set tokens.txt path")
            return
        if not output_path:
            self.status_var.set("Validation failed: output path is missing")
            self._set_output_text("Validation error:\nPlease set output file path.")
            messagebox.showerror("Missing output", "Please set output file path")
            return

        try:
            self._validate_input_text()
        except Exception as err:
            self.status_var.set("Validation failed: invalid wake-word input")
            self._set_output_text(f"Validation error:\n{err}")
            messagebox.showerror("Invalid wake-word input", str(err))
            return

        try:
            input_path = self._resolve_input_path()
            cmd = self._build_command(input_path, output_path)
        except Exception as err:
            self.status_var.set("Invalid config")
            self._set_output_text(f"Invalid config:\n{err}")
            messagebox.showerror("Invalid config", str(err))
            return

        cmd_text = " ".join(shlex.quote(part) for part in cmd)
        self._set_output_text(f"$ {cmd_text}\n\n[status]\nRunning text2token...")
        self.status_var.set("Running sherpa-onnx-cli text2token...")
        self.root.update_idletasks()

        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
        except FileNotFoundError:
            messagebox.showerror(
                "Command not found",
                "sherpa-onnx-cli not found. Install via: pip install sherpa-onnx\n"
                "or ensure it is available in PATH.",
            )
            self.status_var.set("Failed: sherpa-onnx-cli not found")
            self._set_output_text(
                "Command not found:\n"
                "sherpa-onnx-cli not found. Install via: pip install sherpa-onnx\n"
                "or ensure it is available in PATH."
            )
            return
        except Exception as err:
            messagebox.showerror("Run failed", str(err))
            self.status_var.set("Run failed")
            self._set_output_text(f"Run failed:\n{err}")
            return

        out = (proc.stdout or "").strip()
        err = (proc.stderr or "").strip()

        report_parts = [
            f"$ {cmd_text}",
            f"exit_code={proc.returncode}",
            "",
            "[stdout]",
            out or "(empty)",
            "",
            "[stderr]",
            err or "(empty)",
        ]

        if proc.returncode != 0:
            detail = "\n\n".join(part for part in [out, err] if part)
            messagebox.showerror("text2token failed", detail or "Unknown error")
            self.status_var.set(f"Failed (exit={proc.returncode})")
            self._set_output_text("\n".join(report_parts))
            return

        self.status_var.set(f"Success: wrote {output_path}")
        p = Path(output_path)
        generated = p.read_text(encoding="utf-8", errors="replace") if p.exists() else "(output file not found)"
        report_parts.extend([
            "",
            "[generated_output]",
            generated or "(empty)",
            "",
            "[feedback]",
            f"Success. Output written to: {output_path}",
        ])
        self._set_output_text("\n".join(report_parts))

    def _resolve_input_path(self) -> str:
        explicit = self.input_path_var.get().strip()
        content = self.input_text.get("1.0", tk.END).strip()

        if explicit:
            Path(explicit).parent.mkdir(parents=True, exist_ok=True)
            Path(explicit).write_text(content + "\n", encoding="utf-8")
            return explicit

        fd, temp_path = tempfile.mkstemp(prefix="kws_keywords_", suffix=".txt")
        os.close(fd)
        Path(temp_path).write_text(content + "\n", encoding="utf-8")
        return temp_path

    def _load_output_preview(self, output_path: str) -> None:
        p = Path(output_path)
        if not p.exists():
            self.output_text.delete("1.0", tk.END)
            self.output_text.insert("1.0", f"Output file not found: {output_path}")
            return

        content = p.read_text(encoding="utf-8", errors="replace")
        self.output_text.delete("1.0", tk.END)
        self.output_text.insert("1.0", content)


def main() -> int:
    root = tk.Tk()
    app = Text2TokenGUI(root)
    _ = app
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
