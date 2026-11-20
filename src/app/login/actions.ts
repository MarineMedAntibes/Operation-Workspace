"use server";
import { supabase, isConfigured } from "@/lib/supabase";
import { redirect } from "next/navigation";
export async function signIn(form: FormData) {
  if (!isConfigured()) redirect("/login?error=configuration");
  const db = await supabase();
  const { error } = await db.auth.signInWithPassword({ email: String(form.get("email") ?? ""), password: String(form.get("password") ?? "") });
  if (error) redirect("/login?error=credentials");
  redirect("/");
}
export async function signOut() {
  const db = await supabase(); await db.auth.signOut(); redirect("/login");
}
