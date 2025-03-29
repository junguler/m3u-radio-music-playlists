#!/bin/bash

# scrape the links from internet radio
curl -s https://onlineradiobox.com/genres/ | htmlq -a href a | grep "genre" | grep -v "genres" | sort | uniq | awk -F "/" '{print $3}' > genres.txt

# scrape links of the streams
for i in $(cat genres.txt) ; do curl --socks5 127.0.0.1:10808 -s https://onlineradiobox.com/genre/$i/ | htmlq .stations-list button '.station_play, .b-play' | sed -r 's/.*radioname="([^"]*)".*stream="([^"]*)".*/#EXTINF:-1,\1\n\2/' | sed 's/\;//g' >> A-$i.txt ; echo -e "$i" ; done
for i in $(cat genres.txt) ; do for j in \?p={1..200} ; do curl -s https://onlineradiobox.com/genre/$i/$j | htmlq .stations-list button '.station_play, .b-play' | sed -r 's/.*radioname="([^"]*)".*stream="([^"]*)".*/#EXTINF:-1,\1\n\2/' | sed 's/\;//g' >> A-$i.txt ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in A-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert files to m3u extension
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA and double extensions from files
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done
