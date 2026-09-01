"use client";

import { useState, type FormEvent } from "react";
import { brand } from "@/lib/content";
import { btnPrimary } from "@/lib/styles";

const MESSAGE_MAX_LENGTH = 500;

export default function ContactForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const subject = encodeURIComponent(`Website inquiry from ${name || "a visitor"}`);
    const body = encodeURIComponent(`${message}\n\n— ${name} (${email})`);
    window.location.href = `mailto:${brand.email}?subject=${subject}&body=${body}`;
    setSubmitted(true);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="text-xs font-semibold uppercase tracking-wider text-text-dim">
          Name
        </label>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-lg border border-white/15 bg-surface/70 px-4 py-2.5 text-text focus:border-brand focus:outline-none"
        />
      </div>
      <div>
        <label className="text-xs font-semibold uppercase tracking-wider text-text-dim">
          Email
        </label>
        <input
          required
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-lg border border-white/15 bg-surface/70 px-4 py-2.5 text-text focus:border-brand focus:outline-none"
        />
      </div>
      <div>
        <label className="text-xs font-semibold uppercase tracking-wider text-text-dim">
          Message
        </label>
        <textarea
          required
          rows={4}
          maxLength={MESSAGE_MAX_LENGTH}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="mt-1 w-full rounded-lg border border-white/15 bg-surface/70 px-4 py-2.5 text-text focus:border-brand focus:outline-none"
        />
        <p className="mt-1 text-right text-[10px] text-text-dim/60">
          {message.length}/{MESSAGE_MAX_LENGTH}
        </p>
      </div>
      <button
        type="submit"
        className={`w-full ${btnPrimary()}`}
      >
        {submitted ? "Opening your email app…" : "Send via Email"}
      </button>
      <p className="text-center text-xs text-text-dim/70">
        {submitted
          ? `If nothing opened, email us directly at ${brand.email}.`
          : `Opens your email app addressed to ${brand.email}`}
      </p>
    </form>
  );
}
