import { redirect } from "next/navigation";
import { isConfigured, supabase } from "@/lib/supabase";
import { loadWorkspace } from "@/lib/workspace";
import { demoWorkspace } from "@/lib/demo";
import WorkspaceApp from "@/components/workspace-app";
export const dynamic = "force-dynamic";
export default async function Home() {
  if (!isConfigured()) {
    if (process.env.NODE_ENV !== "production" && process.env.DEMO_MODE === "true") return <WorkspaceApp initial={demoWorkspace()} demo />;
    return <main className="setup-page"><span className="eyebrow">MARINE MEDICAL</span><h1>Your workspace is ready to connect.</h1><p>Configure the Supabase URL and publishable key, run the migration, and invite your staff. See web/README.md for setup.</p><p>For a local fictional preview, set DEMO_MODE=true and run npm run dev.</p></main>;
  }
  const db = await supabase();
  const { data: { user } } = await db.auth.getUser();
  if (!user) redirect("/login");
  try { return <WorkspaceApp initial={await loadWorkspace()} demo={false} />; }
  catch (error) { return <main className="setup-page"><h1>Workspace access</h1><p>{error instanceof Error ? error.message : "Unable to load workspace."}</p><a href="/login">Return to sign in</a></main>; }
}
