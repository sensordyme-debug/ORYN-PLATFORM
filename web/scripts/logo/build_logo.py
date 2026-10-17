import math, json
def f(v): return f"{v:.2f}".rstrip('0').rstrip('.')
def fillet_poly(pts, radii):
    """pts: list of (x,y) closed polygon; radii per vertex. Returns path d with circular fillets."""
    n=len(pts); segs=[]
    for i in range(n):
        p0=pts[i-1]; p1=pts[i]; p2=pts[(i+1)%n]; r=radii[i]
        v1=(p0[0]-p1[0],p0[1]-p1[1]); v2=(p2[0]-p1[0],p2[1]-p1[1])
        l1=math.hypot(*v1); l2=math.hypot(*v2)
        u1=(v1[0]/l1,v1[1]/l1); u2=(v2[0]/l2,v2[1]/l2)
        cosang=max(-1,min(1,u1[0]*u2[0]+u1[1]*u2[1])); ang=math.acos(cosang)
        if r<=0: segs.append((p1,p1,0,0)); continue
        d=r/math.tan(ang/2)
        a=(p1[0]+u1[0]*d,p1[1]+u1[1]*d); b=(p1[0]+u2[0]*d,p1[1]+u2[1]*d)
        cross=u1[0]*u2[1]-u1[1]*u2[0]
        sweep=1 if cross<0 else 0
        segs.append((a,b,r,sweep))
    d=f"M{f(segs[0][1][0])} {f(segs[0][1][1])}"
    for i in range(1,n+1):
        a,b,r,sw=segs[i%n]
        d+=f"L{f(a[0])} {f(a[1])}"
        if r>0: d+=f"A{f(r)} {f(r)} 0 0 {sw} {f(b[0])} {f(b[1])}"
    return d+"Z"
K=0.5523
def rrect(x0,y0,x1,y1,rtl,rtr,rbr,rbl,k=K, ccw=False):
    """rounded rect with (rx,ry) per corner, clockwise in screen coords."""
    (a,b),(c,d_),(e,g),(h,i)=rtl,rtr,rbr,rbl
    p=[]
    p.append(f"M{f(x0+a)} {f(y0)}")
    p.append(f"L{f(x1-c)} {f(y0)}")
    if c or d_: p.append(f"C{f(x1-c+c*k)} {f(y0)} {f(x1)} {f(y0+d_-d_*k)} {f(x1)} {f(y0+d_)}")
    p.append(f"L{f(x1)} {f(y1-g)}")
    if e or g: p.append(f"C{f(x1)} {f(y1-g+g*k)} {f(x1-e+e*k)} {f(y1)} {f(x1-e)} {f(y1)}")
    p.append(f"L{f(x0+h)} {f(y1)}")
    if h or i: p.append(f"C{f(x0+h-h*k)} {f(y1)} {f(x0)} {f(y1-i+i*k)} {f(x0)} {f(y1-i)}")
    p.append(f"L{f(x0)} {f(y0+b)}")
    if a or b: p.append(f"C{f(x0)} {f(y0+b-b*k)} {f(x0+a-a*k)} {f(y0)} {f(x0+a)} {f(y0)}")
    s="".join(p)+"Z"
    if ccw: s=reverse_rrect(x0,y0,x1,y1,rtl,rtr,rbr,rbl,k)
    return s
def reverse_rrect(x0,y0,x1,y1,rtl,rtr,rbr,rbl,k=K):
    (a,b),(c,d_),(e,g),(h,i)=rtl,rtr,rbr,rbl
    p=[f"M{f(x0+a)} {f(y0)}"]
    if a or b: p.append(f"C{f(x0+a-a*k)} {f(y0)} {f(x0)} {f(y0+b-b*k)} {f(x0)} {f(y0+b)}")
    p.append(f"L{f(x0)} {f(y1-i)}")
    if h or i: p.append(f"C{f(x0)} {f(y1-i+i*k)} {f(x0+h-h*k)} {f(y1)} {f(x0+h)} {f(y1)}")
    p.append(f"L{f(x1-e)} {f(y1)}")
    if e or g: p.append(f"C{f(x1-e+e*k)} {f(y1)} {f(x1)} {f(y1-g+g*k)} {f(x1)} {f(y1-g)}")
    p.append(f"L{f(x1)} {f(y0+d_)}")
    if c or d_: p.append(f"C{f(x1)} {f(y0+d_-d_*k)} {f(x1-c+c*k)} {f(y0)} {f(x1-c)} {f(y0)}")
    return "".join(p)+"Z"

T,B=180.9,252.35   # cap top / baseline
s=1.4  # small corner radius
# ---- MARK ----
cx=259.6
outer=[(cx,137.75),(318.2,222.4),(318.2,255.3),(cx,295.76),(200.97,255.3),(200.97,222.4)]
outer_r=[13,4,8,18,8,4]
inner=[(cx,182.8),(2*cx-225.2,236.1),(cx,251.2),(225.2,236.1)]
inner_r=[2,3,22,3]
mark = fillet_poly(outer,outer_r) + fillet_poly(inner[::-1],inner_r[::-1])
# ---- O ----
O = rrect(390.7,T,500.4,B,(30,29),(30,29),(30,29),(30,29)) + rrect(407.5,196.6,483.5,236.65,(12.5,12.5),(12.5,12.5),(12.5,12.5),(12.5,12.5),ccw=True)
# ---- R ----
R_stem = fillet_poly([(528.3,T),(545.4,T),(545.4,B),(528.3,B)],[s,0,s,s])
R_bowl = rrect(536,T,630.4,229.65,(0,0),(26,24),(26.3,19.65),(0,0)) + rrect(545.4,196.6,613,214.35,(0,0),(8,8),(8,8),(0,0),ccw=True)
m=1.244
legL=lambda y: 585.0+m*(y-232); legR=lambda y: 609.4+m*(y-232)
R_leg = fillet_poly([(legL(222),222),(legR(222),222),(legR(B),B),(legL(B),B)],[0,0,s,s])
# fix top-right of bowl: also square top-left handled by stem
# ---- Y ----
k=1.08; c=697.35; w=22.6
xl0=641.1; xr0=xl0+w   # left arm at top
Ys=(688.9,705.8)
yn=T+(c-xr0)/k          # notch
yj=T+(Ys[0]-xl0)/k      # outer edge meets stem
Y=fillet_poly([(xl0,T),(xr0,T),(c,yn),(2*c-xr0,T),(2*c-xl0,T),(Ys[1],yj),(Ys[1],B),(Ys[0],B),(Ys[0],yj)],[s,s,1.2,s,s,0,s,s,0])
# ---- N ----
n=1.193
dL=lambda y: 800.0+n*(y-205); dR=lambda y: 825.4+n*(y-205)
yL=205+(794.8-800.0)/n   # diag lower-left edge meets left stem
yR=205+(859.5-825.4)/n   # diag upper edge meets right stem
xtop=dR(T)
N=fillet_poly([(778.3,T),(xtop,T),(859.5,yR),(859.5,T),(876.2,T),(876.2,B),(dL(B),B),(794.8,yL),(794.8,B),(778.3,B)],[s,s,0,s,s,s,s,0,s,s])
word = O+R_stem+R_bowl+R_leg+Y+N
json.dump({'mark':mark,'word':word},open('paths.json','w'))
print(len(mark),len(word))
