"""
生成插件图标。

设计取向：不复制华为云或码道的官方 logo（那是商标），只用「红色系 + 代码符号」
建立品牌联想。图形本身是自绘的：两枚尖括号夹一个实心点，同时读作「代码」与
「一个连接的节点」。

64px 是下限，所以笔画必须够粗、留白必须够大 —— 细线在小尺寸上会糊成一团。

输出：icons/dsh-connect-codearts-{64,128,256}.png，4x 超采样后降采样，
保证边缘抗锯齿质量。
"""

import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
SCALE = 4

# 华为云红 → 橙的竖向渐变。深色端压在下方，让图标在上浅下深的界面上都不飘。
TOP = (214, 18, 32)
BOTTOM = (255, 106, 0)
WHITE = (255, 255, 255, 255)


def rounded_mask(size, radius):
    """圆角矩形遮罩。用 4x 尺寸画再降采样，圆角才不会出现阶梯。"""
    big = size * SCALE
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=radius * SCALE, fill=255
    )
    return mask


def gradient(size):
    """竖向线性渐变。"""
    big = size * SCALE
    img = Image.new('RGB', (big, big))
    draw = ImageDraw.Draw(img)
    for y in range(big):
        t = y / (big - 1)
        r = round(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
        g = round(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
        b = round(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
        draw.line([(0, y), (big - 1, y)], fill=(r, g, b))
    return img


def glyph(size):
    """
    白色前景：左尖括号 + 右尖括号 + 中心圆点。

    几何比例（相对画布宽度 w）：
      笔画粗细  w * 0.115   —— 64px 上约 7.4px，够厚
      括号外张  0.30w ~ 0.70w
      中心点    半径 0.075w
    """
    big = size * SCALE
    layer = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    w = big
    stroke = round(w * 0.115)
    top = round(w * 0.295)
    bottom = round(w * 0.705)
    apex_dy = (bottom - top) // 2

    # 左括号：左上 → 左中 → 左下
    left_x_out = round(w * 0.255)
    left_x_in = round(w * 0.415)
    draw.line(
        [(left_x_in, top), (left_x_out, top + apex_dy), (left_x_in, bottom)],
        fill=WHITE,
        width=stroke,
        joint='curve',
    )

    # 右括号：镜像
    right_x_out = round(w * 0.745)
    right_x_in = round(w * 0.585)
    draw.line(
        [(right_x_in, top), (right_x_out, top + apex_dy), (right_x_in, bottom)],
        fill=WHITE,
        width=stroke,
        joint='curve',
    )

    # 中心圆点
    dot_r = round(w * 0.072)
    cx = w // 2
    cy = top + apex_dy
    draw.ellipse((cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r), fill=WHITE)

    # 笔画两端补圆头（PIL 的 line 只有 joint 圆角，端点仍是平的）
    for point in [
        (left_x_in, top),
        (left_x_out, top + apex_dy),
        (left_x_in, bottom),
        (right_x_in, top),
        (right_x_out, top + apex_dy),
        (right_x_in, bottom),
    ]:
        draw.ellipse(
            (point[0] - stroke // 2, point[1] - stroke // 2,
             point[0] + stroke // 2, point[1] + stroke // 2),
            fill=WHITE,
        )

    return layer.resize((size, size), Image.LANCZOS)


def build(size, radius_ratio=0.22):
    """
    合成一张图标。

    顺序很重要：渐变与遮罩都在 4x 画布上画，**先降采样到目标尺寸**，再叠前景。
    早先的写法把 4x 的底图与已经降采样的前景直接合成，于是前景只占了左上角
    四分之一，整张图看起来像被裁掉了。
    """
    base = gradient(size).convert('RGBA')
    base.putalpha(rounded_mask(size, round(size * radius_ratio)))
    base = base.resize((size, size), Image.LANCZOS)
    base.alpha_composite(glyph(size))
    return base


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in (64, 128, 256):
        path = os.path.join(OUT, f'dsh-connect-codearts-{size}.png')
        build(size).save(path, 'PNG', optimize=True)
        print(f'{path}  {os.path.getsize(path)} bytes')


if __name__ == '__main__':
    main()
