export type WebappChatBounds = { x:number; y:number; width:number; height:number; viewportWidth:number; viewportHeight:number };
export type WebappChatEmbed = { chatId:string; viewId:string; revision:number; bounds:WebappChatBounds|null };
export function parseWebappChatEmbed(input:Record<string,unknown>):WebappChatEmbed|null {
 if(Object.keys(input).some(key=>!["chatId","viewId","revision","bounds"].includes(key)) || typeof input.chatId!=="string" || !input.chatId.trim() || input.chatId.length>256 || typeof input.viewId!=="string" || !/^[a-zA-Z0-9-]{1,80}$/.test(input.viewId) || !Number.isSafeInteger(input.revision) || Number(input.revision)<1)return null;
 const value=input.bounds;
 if(value!==null){
  if(!value || typeof value!=="object" || Array.isArray(value))return null;
  const b=value as Record<string,unknown>,keys=["x","y","width","height","viewportWidth","viewportHeight"];
  if(Object.keys(b).length!==6 || keys.some(key=>typeof b[key]!=="number" || !Number.isFinite(b[key]) || Math.abs(Number(b[key]))>100000) || ["width","height","viewportWidth","viewportHeight"].some(key=>Number(b[key])<=0))return null;
 }
 return {chatId:input.chatId,viewId:input.viewId,revision:Number(input.revision),bounds:value as WebappChatBounds|null};
}
