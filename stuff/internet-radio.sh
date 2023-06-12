#!/bin/bash

# scrape the links from internet radio
#lynx --dump --listonly --nonumbers https://www.internet-radio.com/stations/ | grep 'https://www.internet-radio.com/stations/' > links.txt
curl -s https://www.internet-radio.com/stations/ | htmlq -a href a | grep "stations" | sort | uniq | sed -e 's/ /%20/g' | cut -c11- | rev | cut -c2- | rev | sed '/^$/d' > genres.txt

# strip unnessery part of links (we'll add them later in the for loop) 
#cat links.txt | sed 's!https://www.internet-radio.com/stations/!!' | sed 's/\///g' | sed '/^$/d' | sed -e 's/ /%20/g' | sort | uniq > links2.txt

# scrape links of the streams
#for i in "" page{2..16} ; do for j in $(cat links2.txt) ; do curl -s https://www.internet-radio.com/stations/$j/$i | htmlq --attribute href a | grep '.m3u' | cut -b 37- | awk -F '\\listen' '{print $1""}' | awk -F '\\.m3u' '{print $1""}' | awk -F '\\&t=' '{print $1""}' | awk '!seen[$0]++' | sed '/^$/d' | awk 'length>10' >> $j.txt ; echo "$j - $i scraped" ; done ; done
for i in "" page{2..50} ; do for j in $(cat genres.txt) ; do curl -s https://www.internet-radio.com/stations/$j/$i | ./htmlq -a href a | grep ".*\.pls$" | grep -v ".*\.m3u$" | cut -f2 -d "?" | cut -f2 -d "=" | cut -f1 -d "&" | uniq >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# a few links have more than 16 pages, the longest page is pop with 50 pages, so if you need all of them you have to run another for loop for them
# these streams need to be scraped for 34 pages or less furthur totaling of 50 pages = "Glam Rock" "Rock" "Classic" "Rock" "Pop"
# for i in page{17..50} ; do for j in "classic%20rock" "glam%20rock" "pop" "rock" ; do curl -s https://www.internet-radio.com/stations/$j/$i.html | htmlq --attribute href a | grep '.m3u' | cut -b 37- | awk -F '\\listen' '{print $1""}' | awk -F '\\.m3u' '{print $1""}' | awk -F '\\&t=' '{print $1""}' | awk '!seen[$0]++' | sed '/^$/d' | awk 'length>10' >> $j.txt ; echo "$j - $i scraped" ; done ; done

# find the stream links, and insert title
for i in A-*.txt ; do for j in $(cat $i) ; do curl $j | grep "Title\|File" | tac | sed 's/File1\=//g' | sed 's/Title1\=/#EXTINF:-1 , /g' >> A$i ; done ; done

# get only the streams that include title
for i in AA-*.txt ; do cat $i | grep -A1 "EXTINF:-1" > A$i ; echo -e $i ; done

# convert links to m3u stream files
#for i in $(cat links2.txt) ; do sed "s/^/#EXTINF:-1\n/" $i.txt | sed '1s/^/#EXTM3U\n/' > $i.m3u ; done
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# convert AAA- and double extensions in file names
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done


# replace %20 in filenames with underline
for i in *.m3u ; do mv -- "$i" "$(printf '%s\n' "$i" | sed 's/%20/_/')" ; done
