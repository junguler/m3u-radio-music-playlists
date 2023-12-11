#!/bin/bash

# get a list of genres,and countries
for i in "" page/{2..5}/ ; do curl -s https://www.allonlineradio.com/online-radio-station/$i | htmlq -a href a | grep tag | awk -F '/' '{print $5}' | tail -n +21 >> genres.txt ; done
for i in "" page/{2..3}/ ; do curl -s https://www.allonlineradio.com/online-radio-directory/$i | htmlq -a href a | awk -F '/' '{print $4}' | grep -v "www.\|allonlineradio\|online-radio-directory" | awk NF | tail -n +21 | head -n -8 >> countries.txt ; done

# get the links to genres
for i in "" page/{2..100}/ ; do for j in $(cat genres.txt) ; do curl -s https://www.allonlineradio.com/tag/$j/$i | htmlq -r .trending-ads .tab-content -a href a | grep -v "tag" | awk -F '/' '{print $4}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# get the links to countires
for i in "" page/{2..100}/ ; do for j in $(cat countries.txt) ; do curl -s https://www.allonlineradio.com/$j/$i | htmlq -r .trending-ads .tab-content -a href a | grep -v "tag" | grep -v $j | awk -F '/' '{print $4}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://www.allonlineradio.com/$j/ > mep1 ; cat mep1 | htmlq -t h2 | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | grep "<source" | awk -F '"' '{print $2}' | sed 's/\;//g' | sed '/^$/d' | sed 's|?type=.mp3||g' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
