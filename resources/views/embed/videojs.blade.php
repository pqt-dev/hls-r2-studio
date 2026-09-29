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
    <script src="https://cdnjs.cloudflare.com/ajax/libs/dplayer/1.27.1/DPlayer.min.js"
            crossorigin="anonymous"></script>
    <script>
        (function () {
            var src = {{ \Illuminate\Support\Js::from($playlistUrl) }};

            var video = {
                url: src,
                type: 'hls',
            };

            var dp = new DPlayer({
                container: document.getElementById('embed-player'),
                video: video,
                playbackSpeed: [0.5, 0.75, 1, 1.25, 1.5, 2],
            });

            dp.container.addEventListener('dblclick', function (e) {
                var rect = dp.container.getBoundingClientRect();
                var current = dp.video.currentTime;
                var duration = dp.video.duration;

                if (e.clientX - rect.left > rect.width / 2) {
                    dp.seek(Math.min(duration, current + 10));
                } else {
                    dp.seek(Math.max(0, current - 10));
                }
            });
        })();
    </script>
</body>
</html>
