import type {RequestHandler} from 'express';

export function createProductAuthentication(ports:{
  verifyMobile(token:string): {sub:unknown}|null;
  authenticateSession: RequestHandler;
}):RequestHandler {
  return (req:any,res,next)=>{
    const header=req.headers.authorization;
    if(header!==undefined){
      if(typeof header!=='string'||!header.startsWith('Bearer '))return res.sendStatus(401);
      const payload=ports.verifyMobile(header.slice(7));
      if(!payload||typeof payload.sub!=='string'||!payload.sub.trim()||payload.sub.length>255||/[\u0000-\u001f\u007f]/.test(payload.sub))return res.sendStatus(401);
      req.user={claims:{sub:payload.sub}};
      return next();
    }
    // The established session middleware checks signature, expiry and refresh.
    // A request body/query/header cannot set req.user through this boundary.
    return ports.authenticateSession(req,res,next);
  };
}
