import { useEffect, useState } from "react";
import type { SignIn } from "@thoth/workspace-protocol";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { LegalLinks } from "./LegalLinks.tsx";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Mark } from "@thoth/app-ui/ui/Mark.tsx";
import { describeLimits } from "@thoth/app-ui/workspace/limits.ts";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import { LanguageSwitch } from "./LanguageSwitch.tsx";
import { track } from "./analytics.ts";
import type { WebEnv } from "./env.ts";

interface Props {
  env: WebEnv;
  signIn: SignIn | undefined;
  limits: Record<string, number> | undefined;
  error: string | null;
  begin(provider: string): Promise<void>;
}

/** The sign-in page: one button per provider the server offers, the demo's caution and limits. */
export function SignInView({ env, signIn, limits, error, begin }: Props) {
  const t = useStrings();
  const [busy, setBusy] = useState<string | null>(null);
  const lines = limits ? describeLimits(limits, t.limits) : [];

  useEffect(() => track({ name: "screen_view", params: { screen: "/app/signin" } }, env.analyticsTarget), [env]);

  return (
    <main className="signin" aria-labelledby="signin-title">
      <div className="signin-card">
        <div className="signin-head">
          <Mark size={32} />
          <span className="signin-switches">
            <ThemeSwitch />
            <LanguageSwitch />
          </span>
        </div>
        <h1 id="signin-title" className="signin-title">
          {t.web.signInTitle}
        </h1>
        <p className="muted">{t.web.signInLead}</p>
        {error && (
          <p role="alert" className="alert alert-danger">
            {error}
          </p>
        )}
        {signIn ? (
          <div className="signin-actions">
            {signIn.providers.map((p) => (
              <Button
                key={p.id}
                variant="primary"
                disabled={busy !== null}
                onClick={() => {
                  setBusy(p.id);
                  void begin(p.id).catch(() => setBusy(null));
                }}
              >
                {busy === p.id ? t.web.signingIn : t.web.signInWith(p.name)}
              </Button>
            ))}
          </div>
        ) : (
          <p className="alert alert-warning">{t.web.noProviders}</p>
        )}
        <p className="server-caution">{t.web.caution}</p>
        {lines.length > 0 && (
          <div className="server-limits">
            <p className="muted">{t.web.limitsTitle}</p>
            <ul>
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
        <LegalLinks />
      </div>
    </main>
  );
}
