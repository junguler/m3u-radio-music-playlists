<?php
ini_set('default_charset', '');
setlocale(LC_ALL, 'en_US.UTF-8');

# Download current m3u playlist from
# https://github.com/junguler/m3u-radio-music-playlists

$m3u_file = file_get_contents('---everything-full.m3u');
$download_logos = true;
$thumbnail_size_large = 200;
$thumbnail_size_small = 80;

?><pre><?php

exit('Find this line to comment out if you want overwrite existing data!');

$station_data_file = file_get_contents('station_data.json');
$station_data = json_decode($station_data_file);

$playlists = explode("#PLAYLIST:",$m3u_file);

$results = [];
foreach($playlists as $playlist){
    $parts = preg_split('/^#EXTINF:[-]\d*\s/m', $playlist);
    $playlist_title = '';
    foreach($parts as $part){
        if (preg_match('/^Online radio: (?<plt>.*)? \(www\.radio\.pervii\.com\)/m', $part, $regs)) {
            $playlist_title = $regs['plt'];
        }
        if (preg_match('%^tvg-logo="(?<logo>[^\s]*)?" group-title="(?<group>[^"]*)", (?<title>.+)? - (?<bitrate>\d*)? kbit/s\r\n(?<url>.*)?\r%m', $part, $regs)) {

            if(!empty($regs['url']) && !empty($regs['logo'])){
                $oldtitle = $regs['title'];
                $title = $oldtitle;

                // replace wrong names
                $title = str_replace('C:\MBStudio\OnAir.txt','Radio Yacht', $title);
                $title = str_replace('%item0%','Radiostudio54', $title);

                // cleaning noisy chars
                $title = iconv('utf-8', 'ASCII//TRANSLIT//IGNORE', $title);
                $title = preg_replace('/[\x00-\x1F\x7F-\xFF]/', '', $title);
                $title = preg_replace('/[\?\|\{\}\/\"\\\]/', '', $title);
                $title = preg_replace('/---/', '', $title);
                $title = preg_replace('/::./', '', $title);
                $title = preg_replace('/.::/', '', $title);
                $title = preg_replace('/:/', '', $title);
                $title = preg_replace('/&#1110;/', 'i', $title);
                $title = preg_replace('/\*/', '', $title);
                $title = preg_replace('/^\./', '', $title);                
                $title = preg_replace('/^-/', '', $title);
                $title = preg_replace('/&#039;/', '', $title);
                $title = preg_replace('/&amp;/', '', $title);
                $title = preg_replace('/&apos;/', '', $title);
                $title = preg_replace('/&quot;/', '', $title);
                $title = preg_replace('/&lt;/', '', $title);
                $title = preg_replace('/&gt;/', '', $title);
                $title = strip_tags($title);
                $title = preg_replace('/\s+/', ' ', $title);
                $title = ltrim($title);
                $title = rtrim($title);
                
                // Can't find out sources, leaving out
                $title = str_ireplace('no name', '', $title);

                if(strlen($title) < 2){
                    continue;
                }

                // genres
                $genre = $playlist_title;
                $genre = preg_replace('/ MUSIC$/i', '', $genre);
                $genre = strtolower($genre);
                $genre = ucfirst($genre);

                if($download_logos){
                    if($logo = file_get_contents($regs['logo'])){
                        $extparts = explode('.',$regs['logo']);
                        $ext = end($extparts);
    
                        $square = $thumbnail_size_large;
                        $size = getimagesizefromstring($logo);
                        $w = $size[0];
                        $h = $size[1];
                        
                        $final = imagecreatetruecolor($square,$square);
                        imagealphablending($final, true);
                        $bg_color = imagecolorallocate ($final, 0, 0, 0);
                        imagefill($final, 0, 0, $bg_color);
    
                        $src = imagecreatefromstring($logo);
    
                        if($h>=$w){
                            $newh=$square;
                            $neww=intval($square*$w/$h);
                            imagecopyresampled(
                                $final, $src, 
                                intval(($square-$neww)/2),0,
                                0,0,
                                $neww, $newh, 
                            $w, $h);
                        } else {
                            $neww=$square;
                            $newh=intval($square*$h/$w);
                            imagecopyresampled(
                            $final, $src, 
                            0,intval(($square-$newh)/2),
                            0,0,
                            $neww, $newh, 
                            $w, $h);
                        }
                            
                        imagedestroy($src);
                        
                        $quality = 80;
                        imagejpeg($final, 'output/radio-logos/' . $title . '.jpg', $quality);
                        imagejpeg($final, 'output/radio-logos/thumbs/' . $title . '.jpg', $quality);
                        
                        $image_sm = imagecreatetruecolor($thumbnail_size_small, $thumbnail_size_small);
                        imagecopyresampled($image_sm, $final, 0, 0, 0, 0, $thumbnail_size_small, $thumbnail_size_small, $thumbnail_size_large, $thumbnail_size_large);
                        imagejpeg($image_sm, 'output/radio-logos/thumbs/' . $title . '_sm.jpg', $quality);

                        imagedestroy($final);
                        imagedestroy($image_sm);
                        
                        echo $title . "\n";
                        flush();
                        ob_flush();
                    }    
                }
                
                $result = (object)[
                    "id" => 0,
                    "station" => $regs['url'],
                    "name" => $title,
                    "type" => "r",
                    "logo" => "local",
                    "genre" => $genre,
                    "broadcaster" => "",
                    "language" => "",
                    "country" => "",
                    "region" => "",
                    "bitrate" => $regs['bitrate'],
                    "format" => "",
                    "geo_fenced" => "No",
                    "home_page" => "",
                    "reserved2" => ""
                ];
            }
            $results[] = $result;
        }        
    }
}

// unique names and stations
$filtered = [];
$stations = [];
$names = [];
foreach($results as $result) {
    if (!in_array(strtolower($result->station), $stations) && !in_array(strtolower($result->name), $names)) {
        $stations[] = strtolower($result->station);
        $names[] = strtolower($result->name);
        $filtered[] = $result;
    }
}
$results = $filtered;

// reindexing elements
$ids = end($station_data->stations);
$id = $ids->id;
foreach($results as $result){
    $id++;
    $result->id = $id;
    $station_data->stations[] = $result;
}

// writing output
$new_station_data = json_encode($station_data, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_PRETTY_PRINT);
file_put_contents('output/station_data.json', $new_station_data);
echo "Done.";