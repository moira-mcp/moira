import React from "react";
import { CodespaceManagement } from "./CodespaceManagement";

/** GitHub's list is separate from codespaces nested under local computers. */
export function GitHubCodespaceManagement() {
  return <CodespaceManagement scope={{ provider: "github-codespaces" }} />;
}
