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
                        'durationDisplay',
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
