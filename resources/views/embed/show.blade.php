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

        #embed-player .art-video {
            object-fit: contain !important;
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
                playbackRate: true,
                setting: true,
                fullscreen: true,
                fullscreenWeb: true,
                pip: true,
                notice: false,
                controls: [
                    {
                        name: 'seekBackward',
                        position: 'left',
                        index: 5,
                        html: '<svg xmlns="http://www.w3.org/2000/svg" height="24" width="24" viewBox="0 0 24 24"><path fill="currentColor" d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8zm-1.1 13.5H9.8v-4h-.9v-.8c.4 0 .7-.1.9-.2.2-.1.4-.3.5-.6h.9v5.6zm5.3-1c-.3.5-.9.8-1.6.8-.7 0-1.3-.3-1.6-.8-.3-.5-.5-1.2-.5-2.1v-.7c0-.9.2-1.6.5-2.1.3-.5.9-.8 1.6-.8.7 0 1.3.3 1.6.8.3.5.5 1.2.5 2.1v.7c0 .9-.2 1.6-.5 2.1zm-.9-4.3c-.1-.3-.4-.4-.7-.4s-.6.1-.7.4c-.1.3-.2.7-.2 1.2v1.1c0 .5.1.9.2 1.2.1.3.4.4.7.4s.6-.1.7-.4c.1-.3.2-.7.2-1.2v-1.1c0-.5-.1-.9-.2-1.2z"/></svg>',
                        click: function () {
                            this.currentTime = Math.max(0, this.currentTime - 10);
                        },
                    },
                    {
                        name: 'seekForward',
                        position: 'left',
                        index: 15,
                        html: '<svg xmlns="http://www.w3.org/2000/svg" height="24" width="24" viewBox="0 0 24 24"><path fill="currentColor" d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8zm-1.1 13.5H9.8v-4h-.9v-.8c.4 0 .7-.1.9-.2.2-.1.4-.3.5-.6h.9v5.6zm5.3-1c-.3.5-.9.8-1.6.8-.7 0-1.3-.3-1.6-.8-.3-.5-.5-1.2-.5-2.1v-.7c0-.9.2-1.6.5-2.1.3-.5.9-.8 1.6-.8.7 0 1.3.3 1.6.8.3.5.5 1.2.5 2.1v.7c0 .9-.2 1.6-.5 2.1zm-.9-4.3c-.1-.3-.4-.4-.7-.4s-.6.1-.7.4c-.1.3-.2.7-.2 1.2v1.1c0 .5.1.9.2 1.2.1.3.4.4.7.4s.6-.1.7-.4c.1-.3.2-.7.2-1.2v-1.1c0-.5-.1-.9-.2-1.2z"/></svg>',
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

            art.template.$video.addEventListener('dblclick', function (e) {
                var rect = this.getBoundingClientRect();
                if (e.clientX - rect.left > rect.width / 2) {
                    art.currentTime = Math.min(art.duration, art.currentTime + 10);
                } else {
                    art.currentTime = Math.max(0, art.currentTime - 10);
                }
            });
        })();
    </script>
</body>
</html>
