import { useLayoutEffect, useState } from "react";
import { ServiceWebviewSurface } from "../../service-webview/ServiceWebviewSurface";
import { createAgentWebclientChatPreviewPath } from "../../../shared/agent-webclient-routes";
import { createSurfaceIdentity } from "../../../shared/surface-identity";
import type { WebappChatEmbed } from "../../../shared/webapp-chat-embed";
export function WebappEmbeddedChat({webappId,view,hostTheme}:{webappId:string;view:WebappChatEmbed;hostTheme:"light"|"dark"}){
 const [frame,setFrame]=useState<{left:number;top:number;width:number;height:number}|null>(null);
 useLayoutEffect(()=>{
  const target=[...document.querySelectorAll<HTMLElement>('[data-webapp-entry]')].find(e=>e.dataset.webappEntry==='webapp:'+webappId)?.querySelector('webview');
  if(!target){setFrame(null);return;}
  const update=()=>{const r=target.getBoundingClientRect();setFrame(r.width>0&&r.height>0?{left:r.left,top:r.top,width:r.width,height:r.height}:null);};
  update();const observer=new ResizeObserver(update);observer.observe(target);window.addEventListener('resize',update);
  return()=>{observer.disconnect();window.removeEventListener('resize',update);};
 },[webappId,view.bounds]);
 const b=view.bounds;if(!frame||!b)return null;
 const sx=frame.width/b.viewportWidth,sy=frame.height/b.viewportHeight;
 const path=createAgentWebclientChatPreviewPath({chatId:view.chatId,presentation:"timeline"});
 return <div style={{position:"fixed",...frame,overflow:"hidden",pointerEvents:"none",zIndex:5}}>
  <div data-webapp-inline-chat style={{position:"absolute",left:b.x*sx,top:b.y*sy,width:b.width*sx,height:b.height*sy,pointerEvents:"auto",overflow:"hidden",borderRadius:8}}>
   <ServiceWebviewSurface key={webappId+view.chatId+view.viewId} active ownerChatId={view.chatId} hostTheme={hostTheme} serviceId="agent-webclient" surfaceIdentity={createSurfaceIdentity("webapp-chat",webappId,{ownerChatId:view.chatId})} surfaceIdentityKey={webappId} surfaceLabel="Agent Chat" desktopRoute={path} embedPath={path} skipContextRegistration loadInitialEmbeddedUrlDirectly suppressInitialLoadingCopy />
  </div>
 </div>;
}
