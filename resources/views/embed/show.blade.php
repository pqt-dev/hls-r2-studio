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
            var poster = {{ \Illuminate\Support\Js::from($thumbnailUrl) }};
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
                poster: poster || '',
                type: 'm3u8',
                customType: {
                    m3u8: playM3u8,
                },
                playbackRate: true,
                controls: [
                    {
                        name: 'seekBackward',
                        position: 'left',
                        index: 5,
                        html: '-10s',
                        click: function () {
                            this.currentTime = Math.max(0, this.currentTime - 10);
                        },
                    },
                    {
                        name: 'seekForward',
                        position: 'left',
                        index: 15,
                        html: '+10s',
                        click: function () {
                            this.currentTime = Math.min(this.duration, this.currentTime + 10);
                        },
                    },
                ],
            };

            if (thumbnails) {
                config.thumbnails = thumbnails;
            }

            new Artplayer(config);
        })();
    </script>
</body>
</html>
