<?php

/**
 * Generates the golden data for the TypeScript slug tests.
 *
 * Usage (read-only, no DB needed):
 *   php desktop-app/scripts/gen-slug-golden.php > desktop-app/test/fixtures/slug-golden.json
 *
 * Output: JSON list of {input, expected} where expected = Illuminate\Support\Str::slug(input).
 * Inputs are the file name WITHOUT extension (the app strips the extension first).
 * Empty results are kept as '' here; the app falls back to 'video'.
 */

require __DIR__.'/../../vendor/autoload.php';

use Illuminate\Support\Str;

$inputs = [
    // Vietnamese, full diacritics
    'Tiếng Việt có dấu',
    'Hướng dẫn sử dụng phần mềm',
    'Đường đi đến trường',
    'ĐƯỜNG ĐI ĐẾN TRƯỜNG',
    'đồng hồ đeo tay',
    'Nguyễn Văn Ánh - Bài giảng số 1',
    'Phở bò Hà Nội ngon tuyệt',
    'quả bưởi ơi, quả bưởi',
    'ẮẰẲẴẶ ắằẳẵặ ẤẦẨẪẬ ấầẩẫậ',
    'ẸẺẼẾỀỂỄỆ ẹẻẽếềểễệ',
    'ỈĨỊ ỉĩị ỌỎỐỒỔỖỘỚỜỞỠỢ ọỏốồổỗộớờởỡợ',
    'ỤỦỨỪỬỮỰ ụủứừửữự ỲỴỶỸ ỳỵỷỹ',
    'Video quay ở Đà Lạt 2024',
    // Uppercase / mixed case
    'MY VIDEO FILE',
    'CamelCaseFileName',
    'Mixed CASE and lower',
    // Emoji
    'Party time 🎉🎉 2024',
    '🔥🔥🔥',
    'Holiday ☀️ beach 🏖️ day',
    'smile 😀 and cry 😭',
    // Whitespace
    'many    spaces   here',
    "tab\tseparated\tname",
    "  leading and trailing  ",
    "new\nline name",
    // Symbols only
    '!!!???',
    '###***$$$',
    '---',
    '___',
    '...',
    '   ',
    '',
    // Long names
    str_repeat('very long file name ', 40),
    str_repeat('Đ', 300),
    str_repeat('a', 1000),
    // Dots
    'a.b.c.d.e',
    'many...dots...here',
    'version 1.2.3 final',
    // Underscores / dashes
    'snake_case_name',
    'under__score__double',
    'dash-ed-name',
    'mix_of-dash_and underscore',
    '_leading_and_trailing_',
    '--leading--and--trailing--',
    // @
    'user@example',
    'meet @ 5pm',
    '@@',
    'a@b@c',
    // Digits
    '20240131',
    '1234567890',
    '007',
    'IMG 0001',
    // Latin accents
    'café résumé',
    'Über Straße',
    'niño año',
    'Æsop og Ølen',
    'Crème brûlée à la façon',
    'Łódź Wrocław Żółć',
    'Åse Öre Ääkkönen',
    'Ĳsselmeer œuvre Œuvre',
    'ß ẞ þ Þ ð Ð',
    'ĂÂÊÔƠƯ ăâêôơư',
    'Škoda Žižek Čapek',
    // Windows-style names
    'Video (1)',
    'Clip [HD] {final}',
    'Tom & Jerry',
    'Tom&Jerry',
    'Report (copy) [2] & more',
    "It's a 'quoted' \"name\"",
    'file #1 - 50% off!',
    'a+b=c',
    '100% (best) [take 2] & final',
    'C - Users - Video',
    // Misc punctuation / symbols
    'a/b',
    'a\\b',
    'what? why! how:',
    'a,b;c',
    '~tilde~ ^caret^ `tick`',
    '(parentheses)',
    'trailing dash -',
    '- leading dash',
    '™ © ® trade',
    '€100 £50 ¥10',
    '½ cup ¼ liter',
    '5° × 3 ÷ 2',
    'x² y³ µm',
    '«quoted» „low“ “curly”',
    'a – b — c … d',
];

$out = [];

foreach ($inputs as $input) {
    $out[] = ['input' => $input, 'expected' => Str::slug($input)];
}

echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), "\n";
