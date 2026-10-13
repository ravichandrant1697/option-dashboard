const erf=x=>{const s=x<0?-1:1;x=Math.abs(x);const t=1/(1+0.3275911*x);
const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);
return s*y;};
const N=x=>0.5*(1+erf(x/Math.SQRT2));
const Np=x=>Math.exp(-x*x/2)/Math.sqrt(2*Math.PI);
const d1=(S,K,T,r,q,s)=>(Math.log(S/K)+(r-q+s*s/2)*T)/(s*Math.sqrt(T));
const call=(S,K,T,r,q,s)=>{const a=d1(S,K,T,r,q,s);const b=a-s*Math.sqrt(T);
return S*Math.exp(-q*T)*N(a)-K*Math.exp(-r*T)*N(b);};
const put=(S,K,T,r,q,s)=>{const a=d1(S,K,T,r,q,s);const b=a-s*Math.sqrt(T);
return K*Math.exp(-r*T)*N(-b)-S*Math.exp(-q*T)*N(-a);};
const gammaF=(S,K,T,r,q,s)=>Math.exp(-q*T)*Np(d1(S,K,T,r,q,s))/(S*s*Math.sqrt(T));

console.log("S=24000 r=6% q=0 IV=12%  | formula vs numerical d2C/dS2 (h=1)\n");
console.log("Strike   DTE   Gamma(formula)  Gamma(numeric CE)  Gamma(numeric PE)");
const h=1,r=0.06,q=0,s=0.12,S=24000;
for(const [K,dte] of [[24000,10],[24000,2],[24000,0.25],[23500,10],[24500,10],[24000,30]]){
  const T=dte/365;
  const gf=gammaF(S,K,T,r,q,s);
  const gc=(call(S+h,K,T,r,q,s)-2*call(S,K,T,r,q,s)+call(S-h,K,T,r,q,s))/(h*h);
  const gp=(put(S+h,K,T,r,q,s)-2*put(S,K,T,r,q,s)+put(S-h,K,T,r,q,s))/(h*h);
  console.log(`${K}  ${String(dte).padStart(5)}   ${gf.toExponential(6)}    ${gc.toExponential(6)}     ${gp.toExponential(6)}`);
}
