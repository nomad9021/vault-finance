import { ErrorBoundary } from "@vault/ui";
import { useApp } from "./state/store.js";
import { ApprovalScreen } from "./screens/ApprovalScreen.js";
import { ConnectScreen } from "./screens/ConnectScreen.js";
import { LoginScreen } from "./screens/LoginScreen.js";
import { SetupScreen } from "./screens/SetupScreen.js";
import { StartupScreen } from "./screens/StartupScreen.js";
import { TrustScreen } from "./screens/TrustScreen.js";
import { AppShell } from "./screens/shell/AppShell.js";

export function App() {
  const screen = useApp((s) => s.screen);

  // Outermost net. The shell has its own boundary around the page body so a
  // page crash keeps the navigation usable; this one only catches failures in
  // the shell itself or the pre-auth screens, where there is nothing left to
  // navigate with.
  return (
    <ErrorBoundary resetKeys={[screen.name]}>
      <Screen />
    </ErrorBoundary>
  );
}

function Screen() {
  const screen = useApp((s) => s.screen);

  switch (screen.name) {
    case "boot":
      return <StartupScreen />;
    case "connect":
      return <ConnectScreen {...(screen.error ? { error: screen.error } : {})} />;
    case "trust":
      return <TrustScreen address={screen.address} probe={screen.probe} />;
    case "setup":
      return <SetupScreen />;
    case "login":
      return <LoginScreen />;
    case "approval":
      return <ApprovalScreen />;
    case "shell":
      return <AppShell />;
  }
}
