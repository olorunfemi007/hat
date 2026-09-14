import Link from "next/link";
import { Brand } from "@/components/brand";
import { Icon } from "@/components/icon";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentUserClaims } from "@/lib/org-context";

export default async function Home() {
  const supabase = await createServerSupabaseClient();
  const claims = await getCurrentUserClaims(supabase);

  if (claims) {
    redirect("/dashboard");
  }

  return (
    <div className="landing-page">
      <header className="landing-header"><Brand /><Link href="/sign-in" className="button-secondary">Sign in <Icon name="arrow" /></Link></header>
      <main className="landing-main">
        <p className="eyebrow">Hard Hat Portal</p>
        <h1>Your fleet.<br /><span>Beautifully connected.</span></h1>
        <p className="landing-description">One workspace for your devices, your sites, and the people who bring it all together.</p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link href="/sign-up" className="button-primary">Get started <Icon name="arrow" /></Link>
          <Link href="/sign-in" className="button-secondary">Sign in to your workspace</Link>
        </div>
        <div className="landing-features">
          <div className="surface"><Icon name="devices" /><h2>Know your fleet</h2><p>Claim devices and keep their availability in view.</p></div>
          <div className="surface"><Icon name="sites" /><h2>A place for every device</h2><p>Organize your fleet around the sites where work happens.</p></div>
          <div className="surface"><Icon name="organization" /><h2>Bring your team together</h2><p>Manage access with clear roles and simple invitations.</p></div>
        </div>
      </main>
      <footer className="landing-footer">Hard Hat · Fleet workspace</footer>
    </div>
  );
}
