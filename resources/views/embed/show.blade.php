<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{{ $video->title }}</title>
    <style>
        html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            background: #000;
        }

        #embed-player {
            width: 100%;
            height: 100%;
        }

        @media (hover: hover) and (pointer: fine) {
            #embed-player .art-video-player .art-controls .art-control {
                min-width: 36px;
            }
        }

        #embed-player .art-video-player .art-controls .art-controls-right {
            flex-shrink: 0;
        }

        @media (max-width: 380px) {
            #embed-player .art-video-player .art-controls .art-control-time {
                display: none;
            }
        }
    </style>
</head>
<body>
    <div id="embed-player"></div>

    <script src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js"
            integrity="sha384-9v3HcdYrO3D+OPDTjZ40RXocgE4GtXVCd3/mCS62JsM93JXgI1afJVuwjFvsu6ni"
            crossorigin="anonymous"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/artplayer/5.4.0/artplayer.min.js"
            integrity="sha512-xHj/H3X0iw3K706GLkh5o4hCyGmRANttLU4My0OVpuv/js7LDRNFFVwazs6G9ANol8B2UzlcE35ltMPcHs3gnA=="
            crossorigin="anonymous"></script>
    <script>
        (function () {
            var src = {{ \Illuminate\Support\Js::from($playlistUrl) }};
            var thumbnails = {{ \Illuminate\Support\Js::from($storyboardThumbnails) }};

            function playM3u8(video, url, art) {
                if (Hls.isSupported()) {
                    if (art.hls) {
                        art.hls.destroy();
                    }
                    var hls = new Hls();
                    hls.loadSource(url);
                    hls.attachMedia(video);
                    art.hls = hls;
                    art.on('destroy', function () {
                        hls.destroy();
                    });
                } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                    video.src = url;
                } else {
                    art.notice.show = 'Unsupported playback format: m3u8';
                }
            }

            var config = {
                container: '#embed-player',
                url: src,
                type: 'm3u8',
                customType: {
                    m3u8: playM3u8,
                },
                fullscreen: true,
                pip: true,
                notice: false,
                autoplay: {{ \Illuminate\Support\Js::from($autoplay) }},
                muted: {{ \Illuminate\Support\Js::from($muted) }},
                controls: [
                    {
                        name: 'seekBackward',
                        position: 'left',
                        index: 5,
                        html: '<svg xmlns="http://www.w3.org/2000/svg" height="24" width="24" viewBox="0 0 24 24"><path fill="currentColor" d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/><text x="12" y="13" text-anchor="middle" dominant-baseline="central" font-size="8" font-weight="700" font-family="Arial, Helvetica, sans-serif" fill="currentColor">10</text></svg>',
                        click: function () {
                            this.currentTime = Math.max(0, this.currentTime - 10);
                        },
                    },
                    {
                        name: 'seekForward',
                        position: 'left',
                        index: 15,
                        html: '<svg xmlns="http://www.w3.org/2000/svg" height="24" width="24" viewBox="0 0 24 24"><path fill="currentColor" d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/><text x="12" y="13" text-anchor="middle" dominant-baseline="central" font-size="8" font-weight="700" font-family="Arial, Helvetica, sans-serif" fill="currentColor">10</text></svg>',
                        click: function () {
                            this.currentTime = Math.min(this.duration, this.currentTime + 10);
                        },
                    },
                ],
            };

            if (thumbnails) {
                config.thumbnails = thumbnails;
            }

            var art = new Artplayer(config);
        })();
    </script>
</body>
</html>
