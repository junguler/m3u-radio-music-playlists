#!/bin/bash

# get the list of all categories
curl -s https://pcradio.ru/ | htmlq -a href a | sort | uniq | awk NF | grep '/zhanr/' | awk -F '/' '{print $3}' > genres.txt
curl -s https://pcradio.ru/ | htmlq -a href a | sort | uniq | awk NF | grep '/strana/' | awk -F '/' '{print $3}' > countries.txt

# extract the station names of everything
for i in "" \?page={2..25} ; do for j in $(cat genres.txt) ; do curl -s https://pcradio.ru/zhanr/$j$i | htmlq .stations-list-wrapper -a href a | grep '/radio/' | awk -F '/' '{print $3}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" \?page={2..37} ; do for j in $(cat countries.txt) ; do curl -s https://pcradio.ru/strana/$j$i | htmlq .stations-list-wrapper -a href a | grep '/radio/' | awk -F '/' '{print $3}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# extract stream links and name
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://pcradio.ru/radio/$j > mep1 ; cat mep1 | htmlq -t h1 | awk NF | sed 's/^[ \t]*//' | awk 'NR==1 {$0="#EXTINF:-1," $0} 1' >> A$i ; cat mep1 | grep "class='station_id'" | awk -F "'" '{print $8}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links - convert weird links to proper http
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
