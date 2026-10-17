import math, sys, os, io, urllib.request, concurrent.futures as cf
from PIL import Image
SVC={'img':'USGSImageryOnly','relief':'USGSShadedReliefOnly','topo':'USGSTopo','hydro':'USGSHydroCached'}
def deg2num(lat, lon, z):
    n=2**z; return (lon+180)/360*n, (1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*n
def num2deg(x,y,z):
    n=2**z; lon=x/n*360-180; lat=math.degrees(math.atan(math.sinh(math.pi*(1-2*y/n)))); return lat,lon
def fetch(svc,z,x,y,cache):
    p=os.path.join(cache,f"{svc}_{z}_{x}_{y}.jpg")
    if not os.path.exists(p):
        url=f"https://basemap.nationalmap.gov/arcgis/rest/services/{SVC[svc]}/MapServer/tile/{z}/{y}/{x}"
        import subprocess; subprocess.run(['curl','-sf','-A','oryn-site-build/1.0','-o',p,url],check=True)
    return Image.open(p).convert('RGB')
def stitch(svc, lat, lon, z, nx, ny, cache, out):
    cx,cy=deg2num(lat,lon,z); x0=int(cx-nx/2); y0=int(cy-ny/2)
    im=Image.new('RGB',(256*nx,256*ny))
    with cf.ThreadPoolExecutor(8) as ex:
        futs={ex.submit(fetch,svc,z,x0+i,y0+j,cache):(i,j) for i in range(nx) for j in range(ny)}
        for f,(i,j) in futs.items(): im.paste(f.result(),(256*i,256*j))
    im.save(out, quality=88)
    nw=num2deg(x0,y0,z); se=num2deg(x0+nx,y0+ny,z)
    print(out, im.size, 'NW', nw, 'SE', se)
    return nw,se
if __name__=='__main__':
    svc,lat,lon,z,nx,ny,out=sys.argv[1],float(sys.argv[2]),float(sys.argv[3]),int(sys.argv[4]),int(sys.argv[5]),int(sys.argv[6]),sys.argv[7]
    stitch(svc,lat,lon,z,nx,ny,os.path.join(os.path.dirname(out) or '.','..','raw'),out)
