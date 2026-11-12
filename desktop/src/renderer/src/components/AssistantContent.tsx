import React, { useState } from "react";
import { parseLocalFileLinks } from "../local-file-links";

export function AssistantContent({ content }: { content: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      {parseLocalFileLinks(content).map((span, index) => span.type === "text" ? span.text : (
        <button
          key={index}
          type="button"
          role="link"
          className="message-file-link"
          title={span.path}
          onClick={async () => {
            setError(null);
            try {
              await window.rhzycode.openLocalFile(span.path);
            } catch (cause) {
              setError(`Could not open file: ${cause instanceof Error ? cause.message : String(cause)}`);
            }
          }}
        >
          {span.text}
        </button>
      ))}
      {error && <div className="message-file-link-error" role="alert">{error}</div>}
    </div>
  );
}
