import io
from PIL import Image
from playwright.sync_api import sync_playwright

saved = {}
errors = []
profile = {"total_rows": 418, "total_cols": 12, "total_missing": 400, "columns": [{"name": "Sex", "kind": "categorical"}, {"name": "Age", "kind": "numeric"}]}
specs = [{"type": "bar", "title": "Count by Sex", "x": "Sex"}, {"type": "bar", "title": "Count by Age", "x": "Age"}]

def api(route):
    path = route.request.url.split('/api/')[-1].split('?')[0]
    if path == 'layout':
        if route.request.method == 'POST':
            saved.update(route.request.post_data_json)
        data = saved or {"widgets": specs}
    else:
        data = {"auth/me": {"user": {"name": "Preview", "email": "preview@example.test", "avatar": "/Images/DataPilot AI Logo.png"}}, "profile": profile, "recommend": {"recommendations": []}, "chart-data": {"labels": ["A", "B"], "values": [266, 152]}, "preview": {"columns": ["Sex", "Age"], "rows": [["A", 25]], "total_rows": 418}}.get(path, {})
    route.fulfill(json=data)

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
    page.on('pageerror', lambda error: (errors.append(str(error)), print('JS error:', error, flush=True)))
    page.on('requestfailed', lambda request: print('Request failed:', request.url, request.failure, flush=True))
    page.route('**/api/**', api)
    page.add_init_script("localStorage.setItem('dp_session', 'ui-regression'); localStorage.setItem('dp_filename', 'Sample');")
    page.goto('http://127.0.0.1:5000/dashboard.html')
    page.wait_for_selector('#dashGrid .viz-card')
    assert page.locator('#dashGrid .move-handle').count() == 2, 'Charts need move handles'
    page.click('[data-tab="format"]')
    assert page.locator('#chartBackgroundList [role="switch"]').count() == 2, 'Each chart needs a background switch'
    page.locator('#chartBackgroundGroup summary').click()
    background_switch = page.locator('[data-chart-background="w0"]')
    assert background_switch.get_attribute('aria-checked') == 'true'
    background_switch.click()
    assert background_switch.get_attribute('aria-checked') == 'false'
    assert background_switch.inner_text() == 'OFF'
    assert page.eval_on_selector('#w0', "el => getComputedStyle(el).backgroundColor") == 'rgba(0, 0, 0, 0)'
    assert page.eval_on_selector('#w0', "el => getComputedStyle(el).boxShadow") == 'none'
    assert page.locator('#w0 canvas').is_visible()
    assert page.eval_on_selector('#w0 canvas', "el => getComputedStyle(el).opacity") == '1'
    assert page.eval_on_selector('#w1', "el => getComputedStyle(el).backgroundColor") != 'rgba(0, 0, 0, 0)'
    background_switch.press('Space')
    assert background_switch.get_attribute('aria-checked') == 'true'
    assert page.eval_on_selector('#w0', "el => getComputedStyle(el).boxShadow") != 'none'
    background_switch.click()
    page.locator('#chartBackgroundGroup summary').click()
    print('PASS independent chart background ON/OFF controls, keyboard access, unchanged chart content')
    page.wait_for_timeout(800)
    for kind, width, height in [('16:9', 1280, 720), ('4:3', 1024, 768), ('letter', 816, 1056)]:
        page.select_option('#cvType', kind)
        actual = page.eval_on_selector('#dashCanvas', '(el) => ({width: el.offsetWidth, height: el.offsetHeight})')
        assert actual == {'width': width, 'height': height}, actual
        assert page.locator('#cvWidth').is_disabled()
        print('PASS preset', kind, actual)
    page.select_option('#cvType', 'custom')
    for field, value in [('cvWidth', '900'), ('cvHeight', '1100')]:
        page.fill('#' + field, value)
        page.locator('#' + field).press('Tab')
    assert page.evaluate('pageFormat.canvas.width === 900 && pageFormat.canvas.height === 1100')
    page.select_option('#cvAlign', 'middle')
    assert page.evaluate("document.getElementById('dashGrid').offsetTop > 100")
    page.fill('#cvWidth', '-20')
    page.locator('#cvWidth').press('Tab')
    assert page.input_value('#cvWidth') == '320'
    page.click('#cvReset')
    assert page.input_value('#cvType') == '16:9'
    print('PASS custom dimensions, bounds, middle alignment, reset')

    large_image = io.BytesIO()
    Image.effect_noise((1600, 1000), 100).convert('RGB').save(large_image, format='PNG')
    print('Large test image bytes:', len(large_image.getvalue()))
    image = io.BytesIO()
    Image.new('RGB', (80, 40), (255, 0, 0)).save(image, format='PNG')
    page.evaluate("document.querySelectorAll('.fmt-group').forEach(el => el.open = true)")
    for prefix, target in [('cb', '#canvasBackground'), ('wp', '#wallpaperBackground')]:
        page.locator('#' + prefix + 'Image').set_input_files({'name': 'large.png', 'mimeType': 'image/png', 'buffer': large_image.getvalue()})
        page.wait_for_function("id => document.getElementById(id).naturalWidth === 1600", arg=prefix + 'ImagePreview')
        assert page.eval_on_selector(target, "el => getComputedStyle(el).backgroundImage") != 'none', f'{prefix}: large image was not rendered'
        assert page.locator('#' + prefix + 'ImageStatus').inner_text().startswith('Image applied')
        page.wait_for_timeout(700)
        page.reload()
        page.wait_for_selector('#dashGrid .viz-card')
        page.wait_for_function("id => document.getElementById(id).naturalWidth === 1600", arg=prefix + 'ImagePreview')
        assert page.eval_on_selector(target, "el => getComputedStyle(el).backgroundImage") != 'none'
        page.click('[data-tab="format"]')
        page.evaluate("document.querySelectorAll('.fmt-group').forEach(el => el.open = true)")
        print('PASS', prefix, 'large PNG renders and survives reload')
        page.locator('#' + prefix + 'Image').set_input_files({'name': 'broken.png', 'mimeType': 'image/png', 'buffer': b'not a valid image'})
        page.wait_for_function("id => document.getElementById(id).dataset.state === 'error'", arg=prefix + 'ImageStatus')
        assert page.eval_on_selector('#' + prefix + 'ImagePreview', 'el => el.naturalWidth') == 1600
        assert page.eval_on_selector(target, "el => getComputedStyle(el).backgroundImage") != 'none'
        jpeg = io.BytesIO()
        Image.new('RGB', (100, 60), (0, 0, 255)).save(jpeg, format='JPEG')
        page.locator('#' + prefix + 'Image').set_input_files({'name': 'photo.jpg', 'mimeType': 'image/jpeg', 'buffer': jpeg.getvalue()})
        page.wait_for_function("id => document.getElementById(id).naturalWidth === 100", arg=prefix + 'ImagePreview')
        assert page.eval_on_selector(target, "el => getComputedStyle(el).backgroundImage.includes('data:image/jpeg')")
        print('PASS', prefix, 'invalid uploads preserve previous background and JPEG uploads render')
        page.locator('#' + prefix + 'Image').set_input_files({'name': 'test.png', 'mimeType': 'image/png', 'buffer': image.getvalue()})
        page.wait_for_timeout(200)
        assert page.eval_on_selector(target, "el => getComputedStyle(el).backgroundImage.includes('data:image/png')")
        for fit, expected in [('fill', 'cover'), ('stretch', '100% 100%'), ('fit', 'contain')]:
            page.select_option('#' + prefix + 'Fit', fit)
            assert page.eval_on_selector(target, "el => getComputedStyle(el).backgroundSize") == expected
        page.select_option('#' + prefix + 'Fit', 'stretch')
        if prefix == 'cb':
            page.evaluate("document.getElementById('dashGrid').style.minHeight = '2000px'; document.getElementById('dashGrid').style.visibility = 'hidden'; document.getElementById('dashCanvas').scrollTop = 900")
            page.wait_for_timeout(100)
            shot = Image.open(io.BytesIO(page.locator('#dashCanvas').screenshot()))
            pixel = shot.getpixel((shot.width // 2, shot.height // 2))[:3]
            assert pixel == (255, 0, 0), ('Canvas background disappeared after scrolling', pixel)
            page.evaluate("document.getElementById('dashCanvas').scrollTop = 0; document.getElementById('dashGrid').style.minHeight = ''; document.getElementById('dashGrid').style.visibility = ''")
            print('PASS canvas background stays visible while scrolling')
        else:
            page.evaluate("setCanvasZoom(200); pageFormat.background.transparency = 100; applyPageFormat(); document.getElementById('dashWallpaper').scrollLeft = 1200")
            page.wait_for_timeout(100)
            shot = Image.open(io.BytesIO(page.locator('#dashWallpaper').screenshot()))
            pixel = shot.getpixel((shot.width // 2, shot.height - 30))[:3]
            assert pixel == (255, 0, 0), ('Wallpaper disappeared after scrolling', pixel)
            page.evaluate("document.getElementById('dashWallpaper').scrollLeft = 0; pageFormat.background.transparency = 0; applyPageFormat(); zoomToFit()")
            print('PASS wallpaper stays visible while scrolling at 200% zoom')
        colors = []
        for transparency in [0, 50, 100]:
            page.locator('#' + prefix + 'Trans').evaluate('(el, v) => {el.value = v; el.dispatchEvent(new Event("input", {bubbles:true}));}', transparency)
            assert float(page.eval_on_selector(target, "el => getComputedStyle(el).opacity")) == 1 - transparency / 100
            assert page.locator('#' + prefix + 'TransVal').inner_text() == str(transparency)
            assert page.eval_on_selector('#dashGrid', 'el => getComputedStyle(el).opacity') == '1'
            shot = Image.open(io.BytesIO(page.locator(target).screenshot()))
            colors.append(shot.getpixel((shot.width // 2, 3))[:3])
        assert colors[0][0] >= 240 and colors[0][1] < 40 and colors[0][2] < 40, colors
        assert colors[0] != colors[1] != colors[2], colors
        page.click('#' + prefix + 'Reset')
        assert page.eval_on_selector(target, "el => getComputedStyle(el).backgroundImage") == 'none'
        print('PASS', prefix, 'image fits, transparency pixels, reset:', colors)

    page.evaluate("document.querySelectorAll('.fmt-group').forEach((el, i) => el.open = i === 0)")
    page.select_option('#cvType', '4:3')
    page.wait_for_timeout(700)
    page.reload()
    page.wait_for_selector('#dashGrid .viz-card')
    assert page.evaluate("pageFormat.canvas.type === '4:3'")
    assert page.evaluate('serializeWidgets()[0].showBackground === false')
    assert page.eval_on_selector('#w0', "el => getComputedStyle(el).backgroundColor") == 'rgba(0, 0, 0, 0)'
    assert page.eval_on_selector('#dashCanvas', 'el => el.offsetWidth') == 1024
    print('PASS persisted page format reload')
    page.click('[data-tab="format"]')
    page.click('#cvReset')
    for width in [1440, 1024, 768, 390]:
        page.set_viewport_size({'width': width, 'height': 900})
        page.wait_for_timeout(300)
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), width
        assert page.eval_on_selector('#dashWallpaper', 'el => el.scrollWidth <= el.clientWidth + 1'), width
        print('PASS responsive fit', width)
    page.set_viewport_size({'width': 1440, 'height': 1000})
    page.wait_for_timeout(300)
    before = page.locator('.studio-main').bounding_box()['width']
    for name in ['viz', 'data']:
        page.click('#' + name + 'PaneToggle')
        page.wait_for_timeout(200)
        assert page.locator('#' + name + 'PaneToggle').get_attribute('aria-expanded') == 'false'
        assert page.locator('.studio-main').bounding_box()['width'] > before
        page.click('#' + name + 'PaneToggle')
    page.click('#zoomReset')
    assert page.locator('#zoomPct').inner_text() == '100%'
    page.click('#zoomFit')
    assert page.eval_on_selector('#dashWallpaper', 'el => el.scrollWidth <= el.clientWidth + 1')
    print('PASS reversible pane collapse and zoom')

    def drag(selector, dx, dy):
        control = page.locator(selector)
        control.scroll_into_view_if_needed()
        control.hover()
        box = control.bounding_box()
        x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x + dx, y + dy, steps=6)
        page.mouse.up()
        page.wait_for_timeout(100)

    page.evaluate('setCanvasZoom(50)')
    neighbor = page.locator('#w1').bounding_box()
    drag('#w0 .move-handle', 50, 40)
    geometry = page.evaluate('serializeWidgets()')
    assert abs(geometry[0]['cardX'] - 100) <= 1 and abs(geometry[0]['cardY'] - 80) <= 1, geometry
    after = page.locator('#w1').bounding_box()
    assert abs(after['x'] - neighbor['x']) <= 1 and abs(after['y'] - neighbor['y']) <= 1
    drag('#w0 .move-handle', -30, -20)
    geometry = page.evaluate('serializeWidgets()')
    assert abs(geometry[0]['cardX'] - 40) <= 1 and abs(geometry[0]['cardY'] - 40) <= 1, geometry
    drag('#w0 .move-handle', -200, -200)
    assert page.evaluate('serializeWidgets()[0].cardX === 0 && serializeWidgets()[0].cardY === 0')
    drag('#w0 .move-handle', 2000, 2000)
    assert page.evaluate("(() => {const c = document.getElementById('w0'), g = document.getElementById('dashGrid'); return c.offsetLeft + c.offsetWidth <= g.clientWidth + 1 && c.offsetTop + c.offsetHeight <= g.clientHeight + 1;})()")
    page.evaluate("moveWidget(document.getElementById('w0'), 80, 80)")
    page.locator('#w0 .move-handle').press('ArrowRight')
    page.locator('#w0 .move-handle').press('Shift+ArrowDown')
    assert page.evaluate('serializeWidgets()[0].cardX === 90 && serializeWidgets()[0].cardY === 81')
    box = page.locator('#w0 .move-handle').bounding_box()
    page.mouse.move(box['x'] + 5, box['y'] + 5)
    page.mouse.down()
    page.mouse.move(box['x'] + 45, box['y'] + 45)
    page.keyboard.press('Escape')
    page.mouse.up()
    assert page.evaluate('serializeWidgets()[0].cardX === 90 && serializeWidgets()[0].cardY === 81')
    print('PASS free movement in all directions, zoom, boundaries, keyboard, Escape, stationary neighbors')
    original = page.evaluate('serializeWidgets()[0]')
    drag('#w0 .resize-handle', 40, 20)
    resized = page.evaluate('serializeWidgets()[0]')
    assert abs(resized['cardW'] - original['cardW'] - 80) <= 1, resized
    assert abs(resized['cardH'] - original['cardH'] - 40) <= 1, resized
    assert resized['cardX'] == original['cardX'] and resized['cardY'] == original['cardY']
    page.wait_for_timeout(700)
    page.reload()
    page.wait_for_selector('#dashGrid.free-layout')
    restored = page.evaluate('serializeWidgets()[0]')
    assert all(restored[key] == resized[key] for key in ['cardX', 'cardY', 'cardW', 'cardH']), (restored, resized)
    print('PASS zoom-aware resizing and saved position/size reload')
    page.evaluate("addWidget({type: 'pie', title: 'New chart', x: 'Sex'})")
    assert page.locator('#dashGrid .move-handle').count() == 3
    assert page.evaluate("(() => { const [a,b,c] = serializeWidgets(); return [a,b].every(o => c.cardX >= o.cardX + o.cardW || c.cardX + c.cardW <= o.cardX || c.cardY >= o.cardY + o.cardH || c.cardY + c.cardH <= o.cardY); })()")
    print('PASS adding a chart without overlapping saved positions')
    assert page.locator('#chartBackgroundList [role="switch"]').count() == 3
    assert page.locator('[data-chart-background="w2"]').get_attribute('aria-checked') == 'true'
    page.evaluate("document.getElementById('exportRoot').classList.add('glass-export')")
    assert page.eval_on_selector('#w0', "el => getComputedStyle(el).backgroundColor") == 'rgba(0, 0, 0, 0)'
    assert page.eval_on_selector('#w0', "el => getComputedStyle(el).boxShadow") == 'none'
    assert page.eval_on_selector('#w1', "el => getComputedStyle(el).backgroundColor") != 'rgba(0, 0, 0, 0)'
    page.evaluate("document.getElementById('exportRoot').classList.remove('glass-export')")
    print('PASS new chart backgrounds default ON; export styling preserves individual OFF state')
    page.click('#zoomFit')
    page.evaluate('window.scrollTo(0, 0)')
    page.screenshot(path='_dashboard_check.png', full_page=True)
    with page.expect_download() as download:
        page.click('#exportPngBtn')
    assert download.value.failure() is None
    assert page.eval_on_selector('#dashWallpaper', 'el => el.scrollWidth <= el.clientWidth + 1')
    print('PASS PNG export and restored zoom')
    page.evaluate("addVisualWidget({type: 'line', title: 'Editable chart', x: 'Sex', y: 'Age'})")
    page.click('[data-tab="format"]')
    page.evaluate("document.querySelectorAll('.fmt-group').forEach(el => el.open = el.id === 'chartBackgroundGroup')")
    assert page.locator('#chartBackgroundList [role="switch"]').count() == 4
    page.locator('[data-chart-background="w3"]').click()
    page.evaluate("startEditVisual('w3')")
    page.fill('#vizTitle', 'Renamed chart')
    page.click('#vizAddBtn')
    page.wait_for_function("document.querySelector('#w3').classList.contains('chart-background-off') && document.querySelector('#w3 h4').textContent === 'Renamed chart'")
    assert page.locator('[data-chart-background="w3"]').get_attribute('aria-label') == 'Background for Renamed chart'
    assert page.eval_on_selector('#w3', "el => getComputedStyle(el).backgroundColor") == 'rgba(0, 0, 0, 0)'
    page.evaluate("removeWidget('w3')")
    assert page.locator('#chartBackgroundList [role="switch"]').count() == 3
    print('PASS gallery-chart background survives editing and switch list tracks rename/removal')
    page.click('[data-tab="format"]')
    page.evaluate('window.scrollTo(0, 0)')
    page.screenshot(path='_dashboard_check.png', full_page=True)
    page.wait_for_timeout(700)
    for query in ['view=1', 'embed=1']:
        page.goto('http://127.0.0.1:5000/dashboard.html?' + query)
        page.wait_for_selector('#dashGrid.free-layout')
        assert page.locator('#dashGrid .move-handle, #dashGrid .resize-handle').count() == 0
        current = page.evaluate('serializeWidgets()[0]')
        assert current['showBackground'] is False
        assert page.eval_on_selector('#w0', "el => getComputedStyle(el).backgroundColor") == 'rgba(0, 0, 0, 0)'
        assert page.locator('[data-chart-background="w0"]').is_disabled()
        assert all(current[key] == resized[key] for key in ['cardX', 'cardY', 'cardW', 'cardH'])
    print('PASS saved positions in read-only and embedded views without move/resize controls')
    print('Browser errors:', errors)
    assert not errors, errors
    browser.close()
