<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{{ $video->title }}</title>
    <link rel="stylesheet" href="https://cdn.vidstack.io/player/theme.css" />
    <link rel="stylesheet" href="https://cdn.vidstack.io/player/video.css" />
    <script src="https://cdn.vidstack.io/player@1.15.6" type="module"></script>
    <style>
        html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            background: #000;
        }

        media-player {
            width: 100%;
            height: 100%;
        }

        .vds-gesture {
            position: absolute;
            top: 0;
            bottom: 0;
            width: 50%;
        }

        .vds-gesture:first-of-type {
            left: 0;
        }

        .vds-gesture:last-of-type {
            right: 0;
        }
    </style>
</head>
<body>
    <media-player title="{{ $video->title }}" src="{{ $playlistUrl }}" playsinline>
        <media-provider></media-provider>
        <media-gesture class="vds-gesture" event="dblpointerup" action="seek:-10"></media-gesture>
        <media-gesture class="vds-gesture" event="dblpointerup" action="seek:10"></media-gesture>
        <media-video-layout></media-video-layout>
    </media-player>
</body>
</html>
