"use client";

import { useFormStatus } from "react-dom";

export default function SignInButton() {
  const { pending } = useFormStatus();
  return <button className="primary" disabled={pending}>
    <span aria-live="polite">{pending ? "Signing in…" : "Sign in →"}</span>
  </button>;
}
