import { signIn } from "./actions";
import SignInButton from "./sign-in-button";
export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return <main className="login-page"><div className="login-brand"><span className="brand-icon">⚓</span><h1>Care on board.<br />Confidence ashore.</h1><p>Marine Medical staff workspace</p></div><form action={signIn} className="login-form"><span className="eyebrow">WELCOME BACK</span><h2>Sign in to your workspace</h2><p>Use your staff account to continue.</p>{error && <p role="alert" className="error">{error === "configuration" ? "Connect Supabase before signing in." : "Unable to sign in. Check your email and password."}</p>}<label>Email<input name="email" type="email" autoComplete="username" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" required minLength={8} /></label><SignInButton /><small>Staff access is by invitation.</small></form></main>;
}
