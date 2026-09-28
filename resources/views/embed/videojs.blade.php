<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{{ $video->title }}</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/video.js/8.24.1/video-js.min.css" rel="stylesheet"
          integrity="sha512-uki7RYRF8BrCB9BB7r6BvPTb/HzpCFwSwRoTvdq0pMh0M7CbIMNPrDzZdIbqrx27JkGw2/h8va1X6QAZSKTRvg=="
          crossorigin="anonymous">
    <style>
        html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            background: #000;
        }

        .video-js {
            width: 100%;
            height: 100%;
        }

        .video-js .vjs-control-bar {
            background: linear-gradient(to top, rgba(0, 0, 0, 0.75) 0%, rgba(0, 0, 0, 0.35) 60%, rgba(0, 0, 0, 0) 100%);
            height: 4em;
            padding-top: 1em;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }

        .video-js .vjs-control-bar .vjs-control,
        .video-js .vjs-control-bar .vjs-button,
        .video-js .vjs-time-control,
        .video-js .vjs-menu-button .vjs-menu-content {
            color: #F2E8D9;
        }

        .video-js .vjs-progress-holder {
            background: rgba(255, 255, 255, 0.25);
        }

        .video-js .vjs-load-progress {
            background: rgba(255, 255, 255, 0.3);
        }

        .video-js .vjs-play-progress {
            background: #D9614A;
        }

        .video-js .vjs-play-progress:before {
            color: #F2E8D9;
        }

        .video-js .vjs-control-bar .vjs-icon-placeholder:before {
            content: '';
            display: inline-block;
            width: 1.5em;
            height: 1.5em;
            background-color: currentColor;
            mask-size: contain;
            mask-repeat: no-repeat;
            mask-position: center;
            -webkit-mask-size: contain;
            -webkit-mask-repeat: no-repeat;
            -webkit-mask-position: center;
        }

        .video-js .vjs-play-control .vjs-icon-placeholder:before {
            mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22black%22%3E%3Cpolygon%20points%3D%226%203%2020%2012%206%2021%206%203%22%2F%3E%3C%2Fsvg%3E");
            -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22black%22%3E%3Cpolygon%20points%3D%226%203%2020%2012%206%2021%206%203%22%2F%3E%3C%2Fsvg%3E");
        }

        .video-js .vjs-play-control.vjs-playing .vjs-icon-placeholder:before {
            mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22black%22%3E%3Crect%20x%3D%226%22%20y%3D%224%22%20width%3D%224%22%20height%3D%2216%22%20rx%3D%221%22%2F%3E%3Crect%20x%3D%2214%22%20y%3D%224%22%20width%3D%224%22%20height%3D%2216%22%20rx%3D%221%22%2F%3E%3C%2Fsvg%3E");
            -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22black%22%3E%3Crect%20x%3D%226%22%20y%3D%224%22%20width%3D%224%22%20height%3D%2216%22%20rx%3D%221%22%2F%3E%3Crect%20x%3D%2214%22%20y%3D%224%22%20width%3D%224%22%20height%3D%2216%22%20rx%3D%221%22%2F%3E%3C%2Fsvg%3E");
        }

        .video-js .vjs-mute-control .vjs-icon-placeholder:before,
        .video-js .vjs-mute-control.vjs-vol-1 .vjs-icon-placeholder:before,
        .video-js .vjs-mute-control.vjs-vol-2 .vjs-icon-placeholder:before {
            mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolygon%20points%3D%2211%205%206%209%202%209%202%2015%206%2015%2011%2019%2011%205%22%2F%3E%3Cpath%20d%3D%22M15.54%208.46a5%205%200%200%201%200%207.07%22%2F%3E%3Cpath%20d%3D%22M19.07%204.93a10%2010%200%200%201%200%2014.14%22%2F%3E%3C%2Fsvg%3E");
            -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolygon%20points%3D%2211%205%206%209%202%209%202%2015%206%2015%2011%2019%2011%205%22%2F%3E%3Cpath%20d%3D%22M15.54%208.46a5%205%200%200%201%200%207.07%22%2F%3E%3Cpath%20d%3D%22M19.07%204.93a10%2010%200%200%201%200%2014.14%22%2F%3E%3C%2Fsvg%3E");
        }

        .video-js .vjs-mute-control.vjs-vol-0 .vjs-icon-placeholder:before {
            mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolygon%20points%3D%2211%205%206%209%202%209%202%2015%206%2015%2011%2019%2011%205%22%2F%3E%3Cline%20x1%3D%2222%22%20y1%3D%229%22%20x2%3D%2216%22%20y2%3D%2215%22%2F%3E%3Cline%20x1%3D%2216%22%20y1%3D%229%22%20x2%3D%2222%22%20y2%3D%2215%22%2F%3E%3C%2Fsvg%3E");
            -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolygon%20points%3D%2211%205%206%209%202%209%202%2015%206%2015%2011%2019%2011%205%22%2F%3E%3Cline%20x1%3D%2222%22%20y1%3D%229%22%20x2%3D%2216%22%20y2%3D%2215%22%2F%3E%3Cline%20x1%3D%2216%22%20y1%3D%229%22%20x2%3D%2222%22%20y2%3D%2215%22%2F%3E%3C%2Fsvg%3E");
        }

        .video-js .vjs-icon-cog:before {
            mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%2212%22%20r%3D%223%22%2F%3E%3Cpath%20d%3D%22M19.4%2015a1.65%201.65%200%200%200%20.33%201.82l.06.06a2%202%200%201%201-2.83%202.83l-.06-.06a1.65%201.65%200%200%200-1.82-.33%201.65%201.65%200%200%200-1%201.51V21a2%202%200%200%201-4%200v-.09A1.65%201.65%200%200%200%209%2019.4a1.65%201.65%200%200%200-1.82.33l-.06.06a2%202%200%201%201-2.83-2.83l.06-.06a1.65%201.65%200%200%200%20.33-1.82%201.65%201.65%200%200%200-1.51-1H3a2%202%200%200%201%200-4h.09A1.65%201.65%200%200%200%204.6%209a1.65%201.65%200%200%200-.33-1.82l-.06-.06a2%202%200%201%201%202.83-2.83l.06.06a1.65%201.65%200%200%200%201.82.33H9a1.65%201.65%200%200%200%201-1.51V3a2%202%200%200%201%204%200v.09a1.65%201.65%200%200%200%201%201.51%201.65%201.65%200%200%200%201.82-.33l.06-.06a2%202%200%201%201%202.83%202.83l-.06.06a1.65%201.65%200%200%200-.33%201.82V9a1.65%201.65%200%200%200%201.51%201H21a2%202%200%200%201%200%204h-.09a1.65%201.65%200%200%200-1.51%201z%22%2F%3E%3C%2Fsvg%3E");
            -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%2212%22%20r%3D%223%22%2F%3E%3Cpath%20d%3D%22M19.4%2015a1.65%201.65%200%200%200%20.33%201.82l.06.06a2%202%200%201%201-2.83%202.83l-.06-.06a1.65%201.65%200%200%200-1.82-.33%201.65%201.65%200%200%200-1%201.51V21a2%202%200%200%201-4%200v-.09A1.65%201.65%200%200%200%209%2019.4a1.65%201.65%200%200%200-1.82.33l-.06.06a2%202%200%201%201-2.83-2.83l.06-.06a1.65%201.65%200%200%200%20.33-1.82%201.65%201.65%200%200%200-1.51-1H3a2%202%200%200%201%200-4h.09A1.65%201.65%200%200%200%204.6%209a1.65%201.65%200%200%200-.33-1.82l-.06-.06a2%202%200%201%201%202.83-2.83l.06.06a1.65%201.65%200%200%200%201.82.33H9a1.65%201.65%200%200%200%201-1.51V3a2%202%200%200%201%204%200v.09a1.65%201.65%200%200%200%201%201.51%201.65%201.65%200%200%200%201.82-.33l.06-.06a2%202%200%201%201%202.83%202.83l-.06.06a1.65%201.65%200%200%200-.33%201.82V9a1.65%201.65%200%200%200%201.51%201H21a2%202%200%200%201%200%204h-.09a1.65%201.65%200%200%200-1.51%201z%22%2F%3E%3C%2Fsvg%3E");
        }

        .video-js .vjs-picture-in-picture-control .vjs-icon-placeholder:before {
            mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Crect%20x%3D%222%22%20y%3D%224%22%20width%3D%2220%22%20height%3D%2214%22%20rx%3D%222%22%20ry%3D%222%22%2F%3E%3Crect%20x%3D%2212%22%20y%3D%2211%22%20width%3D%228%22%20height%3D%226%22%20rx%3D%221%22%20ry%3D%221%22%2F%3E%3C%2Fsvg%3E");
            -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Crect%20x%3D%222%22%20y%3D%224%22%20width%3D%2220%22%20height%3D%2214%22%20rx%3D%222%22%20ry%3D%222%22%2F%3E%3Crect%20x%3D%2212%22%20y%3D%2211%22%20width%3D%228%22%20height%3D%226%22%20rx%3D%221%22%20ry%3D%221%22%2F%3E%3C%2Fsvg%3E");
        }

        .video-js .vjs-fullscreen-control .vjs-icon-placeholder:before {
            mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M8%203H5a2%202%200%200%200-2%202v3%22%2F%3E%3Cpath%20d%3D%22M21%208V5a2%202%200%200%200-2-2h-3%22%2F%3E%3Cpath%20d%3D%22M3%2016v3a2%202%200%200%200%202%202h3%22%2F%3E%3Cpath%20d%3D%22M16%2021h3a2%202%200%200%200%202-2v-3%22%2F%3E%3C%2Fsvg%3E");
            -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M8%203H5a2%202%200%200%200-2%202v3%22%2F%3E%3Cpath%20d%3D%22M21%208V5a2%202%200%200%200-2-2h-3%22%2F%3E%3Cpath%20d%3D%22M3%2016v3a2%202%200%200%200%202%202h3%22%2F%3E%3Cpath%20d%3D%22M16%2021h3a2%202%200%200%200%202-2v-3%22%2F%3E%3C%2Fsvg%3E");
        }

        .vjs-fullscreen .vjs-fullscreen-control .vjs-icon-placeholder:before {
            mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M8%203v3a2%202%200%200%201-2%202H3%22%2F%3E%3Cpath%20d%3D%22M21%208h-3a2%202%200%200%201-2-2V3%22%2F%3E%3Cpath%20d%3D%22M3%2016h3a2%202%200%200%201%202%202v3%22%2F%3E%3Cpath%20d%3D%22M16%2021v-3a2%202%200%200%201%202-2h3%22%2F%3E%3C%2Fsvg%3E");
            -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M8%203v3a2%202%200%200%201-2%202H3%22%2F%3E%3Cpath%20d%3D%22M21%208h-3a2%202%200%200%201-2-2V3%22%2F%3E%3Cpath%20d%3D%22M3%2016h3a2%202%200%200%201%202%202v3%22%2F%3E%3Cpath%20d%3D%22M16%2021v-3a2%202%200%200%201%202-2h3%22%2F%3E%3C%2Fsvg%3E");
        }

        .video-js .vjs-skip-backward-10 .vjs-icon-placeholder:before {
            mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22black%22%3E%3Cpath%20d%3D%22M12%205V1L7%206l5%205V7c3.31%200%206%202.69%206%206s-2.69%206-6%206-6-2.69-6-6H4c0%204.42%203.58%208%208%208s8-3.58%208-8-3.58-8-8-8zm-1.1%2013.5H9.8v-4h-.9v-.8c.4%200%20.7-.1.9-.2.2-.1.4-.3.5-.6h.9v5.6zm5.3-1c-.3.5-.9.8-1.6.8-.7%200-1.3-.3-1.6-.8-.3-.5-.5-1.2-.5-2.1v-.7c0-.9.2-1.6.5-2.1.3-.5.9-.8%201.6-.8.7%200%201.3.3%201.6.8.3.5.5%201.2.5%202.1v.7c0%20.9-.2%201.6-.5%202.1zm-.9-4.3c-.1-.3-.4-.4-.7-.4s-.6.1-.7.4c-.1.3-.2.7-.2%201.2v1.1c0%20.5.1.9.2%201.2.1.3.4.4.7.4s.6-.1.7-.4c.1-.3.2-.7.2-1.2v-1.1c0-.5-.1-.9-.2-1.2z%22%2F%3E%3C%2Fsvg%3E");
            -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22black%22%3E%3Cpath%20d%3D%22M12%205V1L7%206l5%205V7c3.31%200%206%202.69%206%206s-2.69%206-6%206-6-2.69-6-6H4c0%204.42%203.58%208%208%208s8-3.58%208-8-3.58-8-8-8zm-1.1%2013.5H9.8v-4h-.9v-.8c.4%200%20.7-.1.9-.2.2-.1.4-.3.5-.6h.9v5.6zm5.3-1c-.3.5-.9.8-1.6.8-.7%200-1.3-.3-1.6-.8-.3-.5-.5-1.2-.5-2.1v-.7c0-.9.2-1.6.5-2.1.3-.5.9-.8%201.6-.8.7%200%201.3.3%201.6.8.3.5.5%201.2.5%202.1v.7c0%20.9-.2%201.6-.5%202.1zm-.9-4.3c-.1-.3-.4-.4-.7-.4s-.6.1-.7.4c-.1.3-.2.7-.2%201.2v1.1c0%20.5.1.9.2%201.2.1.3.4.4.7.4s.6-.1.7-.4c.1-.3.2-.7.2-1.2v-1.1c0-.5-.1-.9-.2-1.2z%22%2F%3E%3C%2Fsvg%3E");
        }

        .video-js .vjs-skip-forward-10 .vjs-icon-placeholder:before {
            mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22black%22%3E%3Cpath%20d%3D%22M12%205V1l5%205-5%205V7c-3.31%200-6%202.69-6%206s2.69%206%206%206%206-2.69%206-6h2c0%204.42-3.58%208-8%208s-8-3.58-8-8%203.58-8%208-8zm-1.1%2013.5H9.8v-4h-.9v-.8c.4%200%20.7-.1.9-.2.2-.1.4-.3.5-.6h.9v5.6zm5.3-1c-.3.5-.9.8-1.6.8-.7%200-1.3-.3-1.6-.8-.3-.5-.5-1.2-.5-2.1v-.7c0-.9.2-1.6.5-2.1.3-.5.9-.8%201.6-.8.7%200%201.3.3%201.6.8.3.5.5%201.2.5%202.1v.7c0%20.9-.2%201.6-.5%202.1zm-.9-4.3c-.1-.3-.4-.4-.7-.4s-.6.1-.7.4c-.1.3-.2.7-.2%201.2v1.1c0%20.5.1.9.2%201.2.1.3.4.4.7.4s.6-.1.7-.4c.1-.3.2-.7.2-1.2v-1.1c0-.5-.1-.9-.2-1.2z%22%2F%3E%3C%2Fsvg%3E");
            -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22black%22%3E%3Cpath%20d%3D%22M12%205V1l5%205-5%205V7c-3.31%200-6%202.69-6%206s2.69%206%206%206%206-2.69%206-6h2c0%204.42-3.58%208-8%208s-8-3.58-8-8%203.58-8%208-8zm-1.1%2013.5H9.8v-4h-.9v-.8c.4%200%20.7-.1.9-.2.2-.1.4-.3.5-.6h.9v5.6zm5.3-1c-.3.5-.9.8-1.6.8-.7%200-1.3-.3-1.6-.8-.3-.5-.5-1.2-.5-2.1v-.7c0-.9.2-1.6.5-2.1.3-.5.9-.8%201.6-.8.7%200%201.3.3%201.6.8.3.5.5%201.2.5%202.1v.7c0%20.9-.2%201.6-.5%202.1zm-.9-4.3c-.1-.3-.4-.4-.7-.4s-.6.1-.7.4c-.1.3-.2.7-.2%201.2v1.1c0%20.5.1.9.2%201.2.1.3.4.4.7.4s.6-.1.7-.4c.1-.3.2-.7.2-1.2v-1.1c0-.5-.1-.9-.2-1.2z%22%2F%3E%3C%2Fsvg%3E");
        }
    </style>
</head>
<body>
    <video id="videojs-embed-player" class="video-js" playsinline></video>

    <script src="https://cdnjs.cloudflare.com/ajax/libs/video.js/8.24.1/video.min.js"
            integrity="sha512-sRxq4fhpy/EbkRIr8G96Fi2Do/qScfr9XlG5NbtBl3Gsgh+x/oWTw/nWgW03SuD7w2TZGVrQHpScJeNPVrAQzQ=="
            crossorigin="anonymous"></script>
    @if ($spriteThumbnails)
        <script src="https://unpkg.com/videojs-sprite-thumbnails@2.2.6/dist/videojs-sprite-thumbnails.min.js"
                integrity="sha512-Qwe3NAkwpyQLanL189ill1Zam8Ug67GgsP058FpQhEGcxE7BHUeytxcxHMxV23l7cmvSyuBoqwiCi0hGCiSccg=="
                crossorigin="anonymous"></script>
    @endif
    <script>
        (function () {
            var src = {{ \Illuminate\Support\Js::from($playlistUrl) }};
            var poster = {{ \Illuminate\Support\Js::from($thumbnailUrl) }};
            var sprite = {{ \Illuminate\Support\Js::from($spriteThumbnails) }};

            var options = {
                sources: [{ src: src, type: 'application/x-mpegURL' }],
                controls: true,
                fill: true,
                playbackRates: [0.5, 1, 1.5, 2],
                userActions: { doubleClick: false },
                controlBar: {
                    skipButtons: { forward: 10, backward: 10 },
                    children: [
                        'playToggle',
                        'volumePanel',
                        'currentTimeDisplay',
                        'timeDivider',
                        'remainingTimeDisplay',
                        'skipBackward',
                        'skipForward',
                        'progressControl',
                        'customControlSpacer',
                        'playbackRateMenuButton',
                        'pictureInPictureToggle',
                        'fullscreenToggle',
                    ],
                },
            };

            if (poster) {
                options.poster = poster;
            }

            var player = videojs('videojs-embed-player', options);

            if (sprite) {
                player.ready(function () {
                    player.spriteThumbnails(sprite);
                });
            }

            player.el().addEventListener('dblclick', function (e) {
                var rect = player.el().getBoundingClientRect();
                var mid = rect.left + rect.width / 2;
                var current = player.currentTime();
                var duration = player.duration() || 0;

                if (e.clientX > mid) {
                    player.currentTime(Math.min(duration, current + 10));
                } else {
                    player.currentTime(Math.max(0, current - 10));
                }
            });
        })();
    </script>
</body>
</html>
