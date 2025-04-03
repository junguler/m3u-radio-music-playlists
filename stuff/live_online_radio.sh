#!/bin/bash

# scrape the links
curl https://liveonlineradio.net/countries | htmlq -a href a | grep "/category/" | awk -F '/' '{print $5}' | sort | uniq > countries.txt 
curl https://liveonlineradio.net/genres | htmlq -a href a | grep '/genres/' | awk -F '/' '{print $5}' | sort | uniq > genres.txt > genres.txt

# get the links for the webpages
for i in "" page/{2..200} ; do for j in $(cat countries.txt) ; do curl -s https://liveonlineradio.net/category/$j/$i | htmlq '.m-b' -a href a | awk -F '/' '{print $4}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" page/{2..200} ; do for j in $(cat genres.txt) ; do curl -s https://liveonlineradio.net/genres/$j/$i | htmlq '.m-b' -a href a | awk -F '/' '{print $4}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# scrape the links from each text file to a m3u output
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://liveonlineradio.net/$j > mep1 ; cat mep1 | htmlq -t h1 | awk 'NR==1 {$0="#EXTINF:-1," $0} 1' >> A$i ; cat mep1 | htmlq -a src audio | head -n 1 | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
