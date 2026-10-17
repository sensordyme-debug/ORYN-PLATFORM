import math, sys, os, subprocess
from PIL import Image
sys.path.insert(0, os.path.dirname(__file__))
from stitch import deg2num, fetch
N,Wl,S,E = 47.11499982620772,-120.08056640625,46.99524110694595,-119.81689453125
# z14 basemap pixel (3072x2048) origin tile:
def z14px_to_global(x,y,z):
    # basemap origin at z14 tile coords:
    ox,oy = deg2num(N,Wl,14)
    gx = (ox*256 + x) / 256 / 2**14 * 2**z * 256
    gy = (oy*256 + y) / 256 / 2**14 * 2**z * 256
    return gx, gy
def region(x0,y0,x1,y1,z,out,cache='raw'):
    gx0,gy0 = z14px_to_global(x0,y0,z); gx1,gy1 = z14px_to_global(x1,y1,z)
    tx0,ty0,tx1,ty1 = int(gx0//256), int(gy0//256), int(gx1//256), int(gy1//256)
    im = Image.new('RGB',((tx1-tx0+1)*256,(ty1-ty0+1)*256))
    for tx in range(tx0,tx1+1):
        for ty in range(ty0,ty1+1):
            im.paste(fetch('img',z,tx,ty,cache),((tx-tx0)*256,(ty-ty0)*256))
    crop = im.crop((int(gx0-tx0*256),int(gy0-ty0*256),int(gx1-tx0*256),int(gy1-ty0*256)))
    crop.save(out, quality=90); print(out, crop.size)
if __name__=='__main__':
    a=sys.argv; region(*map(float,a[1:5]), int(a[5]), a[6])
