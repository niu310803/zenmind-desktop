import { useState } from "react";
import { SettingsSidebarIcon } from "./SettingsSidebarIcon";

export function WebappIcon({ iconDataUrl }: { iconDataUrl?: string }) {
  const [failedDataUrl, setFailedDataUrl] = useState<string>();
  // Package icons arrive as bounded image bytes from Main, never file or remote URLs.
  const imageUrl = /^data:image\/(?:png|jpeg|gif|webp|x-icon|svg\+xml);base64,/u.test(iconDataUrl ?? "")
    ? iconDataUrl
    : undefined;

  return (
    <span className="sidebar-webapp-icon" aria-hidden="true">
      {imageUrl && imageUrl !== failedDataUrl ? (
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          onError={() => setFailedDataUrl(imageUrl)}
        />
      ) : (
        <SettingsSidebarIcon kind="webapps" />
      )}
    </span>
  );
}
